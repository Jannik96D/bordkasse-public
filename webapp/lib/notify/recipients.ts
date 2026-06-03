/**
 * Reine Helfer zur Empfänger-Bestimmung für Web-Push. Getrennt von der
 * (server-only) Versand-Logik, damit die Regeln mit Vitest prüfbar sind.
 */

/**
 * Dedupliziert die Empfänger-IDs und entfernt den Auslöser der Aktion.
 *
 * Anti-Spam-Regel A: Wer die Aktion gerade selbst in der App ausgelöst hat,
 * braucht keinen „du hast X getan"-Push — die Bestätigungs-Mail bekommt er
 * trotzdem. Leere/`null`-Werte werden herausgefiltert.
 */
export function pushRecipients(
  ids: (string | null | undefined)[],
  opts: { excludeActorId?: string | null } = {},
): string[] {
  const exclude = opts.excludeActorId ?? null;
  const out = new Set<string>();
  for (const id of ids) {
    if (!id) continue;
    if (exclude && id === exclude) continue;
    out.add(id);
  }
  return Array.from(out);
}
