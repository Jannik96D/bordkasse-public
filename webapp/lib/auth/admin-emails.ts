/**
 * Liest die Admin-Allowlist aus der Env-Variable ADMIN_EMAILS.
 * Format: komma-separiert, Leerzeichen werden getrimmt, Vergleich
 * lowercase. Wenn die Variable nicht gesetzt ist, ist niemand Admin
 * (fail-closed → niemand darf Törns anlegen).
 *
 * Eigene Datei (statt in authz.ts), damit `getCurrentPerson` sie ohne
 * Import-Zyklus nutzen kann; authz.ts re-exportiert sie.
 */
export function getAdminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}
