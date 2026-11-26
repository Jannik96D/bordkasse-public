/**
 * Fehlertexte für den Client (Slice 11, Sicherheitsrunde 2026-11).
 *
 * Rohe Postgres-/SMTP-Meldungen dürfen nie in einen Rückgabewert oder eine
 * Response an den Client: Postgres nennt Tabellen-/Constraint-Namen und
 * Werte, nodemailer-Fehler enthalten meist die Empfängeradresse. Details
 * gehören ins Serverlog — und dort nur Codes, keine Adressen/Namen.
 */

/** Postgres-/PostgREST-Fehler → Log (message/code), Rückgabe: fester Text. */
export function dbErr(err: { message: string; code?: string } | null | undefined, fallback: string): string {
  if (err?.message) console.error("[bordkasse:db]", err.code ?? "", err.message);
  return fallback;
}

/**
 * Text für Mail-Fehler — OHNE Roh-Text des SMTP-Servers (der nennt oft die
 * Empfängeradresse; Coolify speichert Cron-Antworten unter „Recent
 * executions"). Nur Code/Antwortcode.
 */
export function safeMailErrorMessage(r: { code?: string; responseCode?: number }): string {
  const parts = [r.code, r.responseCode !== undefined ? String(r.responseCode) : undefined].filter(Boolean);
  return parts.length > 0 ? `Mail-Zustellung fehlgeschlagen (${parts.join(" ")})` : "Mail-Zustellung fehlgeschlagen";
}
