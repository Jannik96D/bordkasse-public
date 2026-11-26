"use client";

import { useEffect } from "react";
import { getMyPersonId } from "@/lib/actions/current-person";
import { cleanupOnLogout } from "@/lib/offline/logout-cleanup";
import {
  browserPersonStorage,
  reconcilePersonSwitch,
  resolveProbe,
  shouldCheck,
  withTimeout,
  type PersonProbe,
} from "@/lib/offline/person-switch";

const MIN_GAP_MS = 30_000;
const TIMEOUT_MS = 8_000;
const CONFIRM_PAUSE_MS = 2_000;

/**
 * Räumt Geräte-lokale Spuren der vorherigen Person auf (Slice 12): beim Laden
 * (erst im Idle) und beim Zurückkehren in den Tab (max. alle 30 s) wird die
 * aktuelle personId mit der gemerkten verglichen. Offline/Fehler/Timeout →
 * nichts tun; „ausgeloggt“ zählt erst nach zwei bestätigenden Abfragen.
 * Der Timeout verhindert, dass eine hängende Action (Server-Actions laufen
 * seriell) Buchungs-Submits blockiert.
 */
export function PersonSwitchGuard() {
  useEffect(() => {
    let cancelled = false;
    let last: number | null = null;
    const storage = browserPersonStorage();
    const probe = (): Promise<PersonProbe> =>
      withTimeout(getMyPersonId(), TIMEOUT_MS, { status: "error" } as PersonProbe);
    const check = async () => {
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      if (!shouldCheck(Date.now(), last, MIN_GAP_MS)) return;
      last = Date.now();
      const current = await resolveProbe(
        probe,
        () => new Promise((r) => setTimeout(r, CONFIRM_PAUSE_MS)),
        storage.read() !== null,
      );
      if (cancelled || current === null) return;
      await reconcilePersonSwitch(current === "none" ? null : current, {
        ...storage,
        cleanup: cleanupOnLogout,
      });
    };
    const idle = (cb: () => void) => {
      const w = window as Window & { requestIdleCallback?: (f: () => void) => number };
      if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(cb);
      else setTimeout(cb, 1500);
    };
    idle(() => void check());
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return null;
}
