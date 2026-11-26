/**
 * Personenwechsel auf geteilten Geräten (Sicherheitsrunde 2026-11, Slice 12).
 *
 * `cleanupOnLogout` lief nur beim Klick auf „Abmelden". Nach Kontolöschung,
 * Kontowechsel per neuem Magic-Link oder abgelaufener Session blieben SW-Caches
 * (Bilanz, Crew) der vorherigen Person offline lesbar. Der Client merkt sich
 * deshalb die zuletzt gesehene personId (nur die UUID, keine PII) und räumt auf,
 * sobald eine andere oder keine Person eingeloggt ist.
 *
 * Die IndexedDB-Outbox wird hier NIE angefasst (ungesyncte Buchungen; der
 * Cross-Login-Schutz über `OutboxItem.personId` bleibt eigenständig).
 */
export const LAST_PERSON_KEY = "bordkasse:last-person:v1";

export type PersonSwitchAction = "none" | "remember" | "cleanup-and-remember" | "cleanup-and-forget";

/** Reine Entscheidung: stored = zuletzt gemerkte ID, current = aktuell eingeloggte ID (oder null). */
export function decidePersonSwitch(stored: string | null, current: string | null): PersonSwitchAction {
  if (current === null) return stored === null ? "none" : "cleanup-and-forget";
  if (stored === null) return "remember";
  return stored === current ? "none" : "cleanup-and-remember";
}

export interface PersonSwitchDeps {
  read: () => string | null;
  write: (id: string | null) => void;
  cleanup: () => Promise<void>;
}

export function browserPersonStorage(): Pick<PersonSwitchDeps, "read" | "write"> {
  return {
    read: () => {
      try {
        return window.localStorage.getItem(LAST_PERSON_KEY);
      } catch {
        return null;
      }
    },
    write: (id) => {
      try {
        if (id === null) window.localStorage.removeItem(LAST_PERSON_KEY);
        else window.localStorage.setItem(LAST_PERSON_KEY, id);
      } catch {
        // Speicher gesperrt → best effort.
      }
    },
  };
}

/** Wirft nie. Räumt zuerst auf und merkt die neue ID erst danach (Abbruch → nächster Versuch). */
export async function reconcilePersonSwitch(
  current: string | null,
  deps: PersonSwitchDeps,
): Promise<PersonSwitchAction> {
  const action = decidePersonSwitch(deps.read(), current);
  try {
    if (action === "cleanup-and-remember" || action === "cleanup-and-forget") await deps.cleanup();
    if (action === "remember" || action === "cleanup-and-remember") deps.write(current);
    if (action === "cleanup-and-forget") deps.write(null);
  } catch {
    // Aufräumen ist best effort und darf die App nie stören.
  }
  return action;
}
