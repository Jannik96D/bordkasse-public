"use client";

import { useEffect } from "react";
import { getMyPersonId } from "@/lib/actions/current-person";
import { cleanupOnLogout } from "@/lib/offline/logout-cleanup";
import { browserPersonStorage, reconcilePersonSwitch } from "@/lib/offline/person-switch";

/**
 * Räumt Geräte-lokale Spuren der vorherigen Person auf (Slice 12): beim Laden
 * und beim Zurückkehren in den Tab wird die aktuelle personId mit der zuletzt
 * gemerkten verglichen. Offline/Fehler → nichts tun (nie aus Unsicherheit löschen).
 */
export function PersonSwitchGuard() {
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      let current: string | null;
      try {
        current = await getMyPersonId();
      } catch {
        return;
      }
      if (cancelled) return;
      await reconcilePersonSwitch(current, { ...browserPersonStorage(), cleanup: cleanupOnLogout });
    };
    void check();
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
