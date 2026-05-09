"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * "Erledigt"-Häkchen pro Schuldenzeile, persistiert via localStorage.
 * Nur lokal beim User — nicht crew-synchron in v0.1.
 */
export function DebtCheckbox({ tripId, debtKey }: { tripId: string; debtKey: string }) {
  const storageKey = `bordkasse:debt:${tripId}:${debtKey}`;

  const subscribe = useCallback((callback: () => void) => {
    const handler = (e: StorageEvent) => {
      if (e.key === null || e.key === storageKey) callback();
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [storageKey]);

  const done = useSyncExternalStore(
    subscribe,
    () => localStorage.getItem(storageKey) === "1",
    () => false,
  );

  const toggle = () => {
    const next = !done;
    if (next) localStorage.setItem(storageKey, "1");
    else localStorage.removeItem(storageKey);
    // Same-Tab-Update: storage-Event feuert nur cross-tab, also manuell.
    window.dispatchEvent(new StorageEvent("storage", { key: storageKey }));
  };

  return (
    <input
      type="checkbox"
      checked={done}
      onChange={toggle}
      className="h-5 w-5 cursor-pointer rounded border-rule"
      aria-label="Als erledigt markieren"
    />
  );
}
