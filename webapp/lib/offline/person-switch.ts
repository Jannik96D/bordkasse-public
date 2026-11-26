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

/** Ergebnis der serverseitigen Abfrage (`getMyPersonId`). `error` = Auth-/Netzfehler, NIE als „ausgeloggt“ werten. */
export type PersonProbe = { status: "person"; id: string } | { status: "none" } | { status: "error" };

/**
 * Wertet eine Abfrage aus: `error` → null (nie aufräumen). `none` bei gemerkter
 * Person muss durch eine zweite Abfrage nach einer Pause bestätigt werden, sonst
 * löscht ein kurzer Auth-Aussetzer die Offline-Caches. Rückgabe: String = Person,
 * `"none"` = bestätigt ausgeloggt, null = unklar (nichts tun).
 */
export async function resolveProbe(
  probe: () => Promise<PersonProbe>,
  pause: () => Promise<void>,
  hasStored: boolean,
): Promise<string | "none" | null> {
  let first: PersonProbe;
  try {
    first = await probe();
  } catch {
    return null;
  }
  if (first.status === "error") return null;
  if (first.status === "person") return first.id;
  if (!hasStored) return "none";
  await pause();
  let second: PersonProbe;
  try {
    second = await probe();
  } catch {
    return null;
  }
  if (second.status === "error") return null;
  return second.status === "person" ? second.id : "none";
}

/** Mindestabstand zwischen zwei Prüfungen. */
export function shouldCheck(now: number, last: number | null, minGapMs: number): boolean {
  return last === null || now - last >= minGapMs;
}

/** Gibt nach `ms` auf; die Originalaktion läuft weiter, blockiert den Aufrufer aber nicht. Wirft nie. */
export async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p.catch(() => fallback), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Beim manuellen Abmelden: gemerkte Person direkt vergessen (kein zweiter Cleanup). */
export function forgetLastPerson(): void {
  browserPersonStorage().write(null);
}

/**
 * Kontolöschung: aufräumen NUR bei Erfolg (bei Ablehnung, z. B. aktive Buchungen,
 * bleibt der Nutzer eingeloggt und behält Caches/Push-Abo). Bei Erfolg mit
 * Redirect kommt der Code hier nie an — das erledigt der PersonSwitchGuard.
 */
export async function deleteThenCleanup<S extends { status: string }>(
  doDelete: () => Promise<S>,
  cleanup: () => Promise<void>,
): Promise<S> {
  const res = await doDelete();
  if (res.status !== "error") await cleanup();
  return res;
}
