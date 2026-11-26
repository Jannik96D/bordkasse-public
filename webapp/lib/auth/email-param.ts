/**
 * Hilfen für den `email`-Parameter der Magic-Link-URL (`/auth/confirm`,
 * `/auth/verify`). Der Wert kommt aus der URL und ist frei fälschbar.
 */

/**
 * Normalisiert eine Adresse für den Vergleich: getrimmt, kleingeschrieben und
 * Leerzeichen → `+`. E-Mail-Adressen enthalten keine Leerzeichen; ein
 * unkodiertes `+` einer Plus-Adresse (`name+tag@…`) wird aber beim Parsen von
 * Query-/Formularwerten zu einem Leerzeichen, was den Vergleich sonst bei
 * legitimen Links scheitern ließe.
 */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase().replace(/\s/g, "+");
}

// Bewusst konservativ (gewöhnliche Adressen): Zeichen wie & # = % ' bleiben
// draußen — sie sind in URLs/Formularen heikel und gelten hier als „exotisch“.
const EMAIL_SHAPE = /^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

/**
 * Liefert die Adresse nur dann zur ANZEIGE zurück, wenn sie wie eine kurze
 * E-Mail-Adresse aussieht — sonst `null` (neutrale Anzeige). Verhindert, dass
 * über den fälschbaren Parameter beliebiger Text („Dein Konto wurde gesperrt,
 * rufe …") in der Bestätigungsseite erscheint.
 */
export function displayableEmail(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = normalizeEmail(value);
  if (normalized.length > 254 || !EMAIL_SHAPE.test(normalized)) return null;
  return normalized;
}
