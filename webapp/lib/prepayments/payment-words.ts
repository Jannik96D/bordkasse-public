/**
 * Einheitliche Wörter für Zahlungen (Anzahlungsplan + weitere Zahlungen) —
 * eine Quelle für App, Mails und Pushs (PR7).
 *
 * Intern heißen weitere Zahlungen `item` (Tabelle `prepayment_items`); in
 * Nutzertexten gibt es das Wort „Posten" nicht mehr.
 *
 * Verben, damit „Zahlung" nicht doppelt belegt ist:
 *   • „Ich habe gezahlt"           — Crew meldet eine Einzahlung
 *   • „Einzahlung erfassen"        — Skipper/vorstreckende Person bucht eine
 *                                    Einzahlung der Crew
 *   • „Überweisung an Anbieter erfassen" — die vorstreckende Person hat an den
 *                                    Anbieter überwiesen
 */

/** Status einer Zahlungs-Meldung (Mail, Push, App). */
export const PAYMENT_STATUS = {
  pending: "gemeldet – wartet auf Bestätigung",
  confirmed: "bestätigt",
  rejected: "abgelehnt",
} as const;

/** Platzhalter, wenn (noch) keine Frist feststeht. */
export const NO_DUE_TEXT = "Frist folgt";

export const ACTION_RECORD = "Einzahlung erfassen";
export const ACTION_PROVIDER = "Überweisung an Anbieter erfassen";
export const ACTION_REPORT = "Ich habe gezahlt";
/** Hauptwort — nur für Überschriften/Navigation/Dialogtitel. */
export const NOUN_ITEMS = "Weitere Zahlungen";
export const NOUN_ITEM = "Weitere Zahlung";

export const LABEL_CREW_PAID = "Von der Crew bezahlt";
export const LABEL_PROVIDER_PAID = "An Anbieter bezahlt";
export const LABEL_PROVIDER_OPEN = "Noch an Anbieter zu überweisen";

/**
 * Freitext für EINE Zeile (Mail-Betreff, Push-Titel): CR/LF/Tabs/Unicode-
 * Zeilentrenner → Leerzeichen (Header-Injection, z. B. „Flüge\r\nBcc: x@y.z"),
 * Mehrfach-Leerzeichen zusammenziehen, auf `max` Zeichen kürzen.
 */
export function cleanLine(s: string, max = 80): string {
  const t = (s ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}
