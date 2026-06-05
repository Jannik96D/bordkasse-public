/**
 * Sicherer Mini-Rechner für Eingaben wie "3 + 17" oder "(2 * 4,50)".
 *
 * Erlaubte Zeichen: Ziffern, Dezimaltrennzeichen ("," oder "."), die vier
 * Grundrechenarten +, -, *, /, Klammern, Whitespace. Alles andere wird
 * abgelehnt — keine Variablen, keine Funktionen, kein Zugriff auf irgendwas.
 *
 * WICHTIG (warum kein Function()/eval mehr): Die Produktions-CSP lässt
 * `'unsafe-eval'` bewusst weg (next.config.ts, Fix S-4). Der frühere
 * `Function('return ('+expr+')')`-Trick wirft dort einen EvalError → der
 * catch lieferte `null` → in PROD (online wie offline) waren alle Pro-Person-
 * Beträge 0 und die Aufteilung „Pro Person" komplett kaputt. Daher werten wir
 * jetzt mit einem eigenen, CSP-sicheren Recursive-Descent-Parser aus (nur
 * + - * / und Klammern). Die strikte Regex bleibt als erste Schranke.
 */
export function safeMathEval(expr: string): number | null {
  if (typeof expr !== "string") return null;
  const cleaned = expr.replace(/,/g, ".").replace(/\s/g, "");
  if (!cleaned) return null;
  // Nur Ziffern, Punkt, Grundrechenarten, Klammern.
  if (!/^[\d.+\-*/()]+$/.test(cleaned)) return null;
  // Mindestens eine Ziffer muss drin sein (kein "+++" o. ä.).
  if (!/\d/.test(cleaned)) return null;
  try {
    const result = evalArithmetic(cleaned);
    if (typeof result !== "number" || !isFinite(result) || result < 0) return null;
    // Auf 2 Nachkommastellen runden (Euro-Cent)
    return Math.round(result * 100) / 100;
  } catch {
    return null;
  }
}

/**
 * CSP-sicherer Arithmetik-Parser (Recursive Descent) für + - * / und Klammern.
 * Wirft bei ungültiger Syntax, Division durch Null oder Resten am Ende — der
 * Aufrufer fängt das und liefert `null`. Erwartet bereits normalisierte
 * Eingabe (Komma→Punkt, ohne Whitespace) aus dem oben per Regex geprüften
 * Zeichensatz (Ziffern, Punkt, Grundrechenarten, Klammern).
 */
function evalArithmetic(input: string): number {
  let i = 0;
  const peek = (): string | undefined => input[i];
  const eof = (): boolean => i >= input.length;

  // expr := term (('+' | '-') term)*
  function parseExpr(): number {
    let value = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = input[i++];
      const rhs = parseTerm();
      value = op === "+" ? value + rhs : value - rhs;
    }
    return value;
  }

  // term := factor (('*' | '/') factor)*
  function parseTerm(): number {
    let value = parseFactor();
    while (peek() === "*" || peek() === "/") {
      const op = input[i++];
      const rhs = parseFactor();
      if (op === "*") {
        value *= rhs;
      } else {
        if (rhs === 0) throw new Error("Division durch Null");
        value /= rhs;
      }
    }
    return value;
  }

  // factor := ('+' | '-')? ( number | '(' expr ')' )
  function parseFactor(): number {
    const c = peek();
    if (c === undefined) throw new Error("unerwartetes Ende");
    if (c === "+" || c === "-") {
      i++;
      const v = parseFactor();
      return c === "-" ? -v : v;
    }
    if (c === "(") {
      i++;
      const v = parseExpr();
      if (peek() !== ")") throw new Error("fehlende schließende Klammer");
      i++;
      return v;
    }
    return parseNumber();
  }

  // number := [0-9.]+  (genau eine valide Dezimalzahl)
  function parseNumber(): number {
    const start = i;
    let ch = input[i];
    while (ch !== undefined && /[0-9.]/.test(ch)) {
      i++;
      ch = input[i];
    }
    const numStr = input.slice(start, i);
    if (!/^\d*\.?\d+$|^\d+\.?\d*$/.test(numStr)) throw new Error("ungültige Zahl");
    const n = Number(numStr);
    if (!isFinite(n)) throw new Error("ungültige Zahl");
    return n;
  }

  const value = parseExpr();
  if (!eof()) throw new Error("unerwarteter Rest"); // z. B. "3)" oder "(3"
  return value;
}
