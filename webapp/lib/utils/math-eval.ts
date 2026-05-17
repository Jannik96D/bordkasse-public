/**
 * Sicherer Mini-Rechner für Eingaben wie "3 + 17" oder "(2 * 4,50)".
 *
 * Erlaubte Zeichen: Ziffern, Dezimaltrennzeichen ("," oder "."), die vier
 * Grundrechenarten +, -, *, /, Klammern, Whitespace. Alles andere wird
 * abgelehnt — keine Variablen, keine Funktionen, kein Zugriff auf irgendwas.
 *
 * Implementierungs-Trick: wir validieren das Input gegen eine strikte Regex,
 * normalisieren Komma zu Punkt, und werten dann via `Function`-Konstruktor
 * aus. Weil die Regex nur arithmetische Zeichen durchlässt, kann der
 * Konstruktor nichts ausführen außer arithmetisches Eval.
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
    const result = Function('"use strict"; return (' + cleaned + ")")();
    if (typeof result !== "number" || !isFinite(result) || result < 0) return null;
    // Auf 2 Nachkommastellen runden (Euro-Cent)
    return Math.round(result * 100) / 100;
  } catch {
    return null;
  }
}
