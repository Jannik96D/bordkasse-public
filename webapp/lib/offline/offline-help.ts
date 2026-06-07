/**
 * Offline-Hilfe: Erkennung, ob das Buchungsformular offline verfügbar ist, und
 * ein „letztes Mal ging Offline-Buchen nicht"-Flag für die Selbsthilfe beim
 * nächsten Online-Sein (Banner in components/offline-banner.tsx).
 *
 * Alles client-only + fail-safe (Guards auf caches/window/localStorage), damit
 * SSR und Test-Umgebungen ohne diese APIs nicht brechen.
 */

// Geteilter localStorage-Key. WICHTIG: identisch in public/offline.html (dort
// inline gesetzt, da die statische Seite kein TS importieren kann).
export const OFFLINE_MISS_KEY = "bordkasse:offline-miss";

export type OfflineMiss = { at: number; path: string };

/**
 * Liegt das vorgewärmte Buchungsformular im Service-Worker-Cache? Geprüft wird
 * versionsunabhängig über alle „…-pages"-Caches (siehe public/sw.js:
 * PAGES_CACHE = `${CACHE_VERSION}-pages`), damit ein CACHE_VERSION-Bump diesen
 * Check nicht still bricht.
 *
 *  - `ignoreSearch`: eine Navigation zu `…/new?draft=X` soll auf das gewärmte
 *    `…/new` treffen.
 *  - `ignoreVary`: Next setzt auf diesen Routen `Vary: RSC, Next-Router-*` →
 *    ein einfacher Lookup verfehlte sonst den eigentlich vorhandenen Treffer.
 *
 * Wirft NIE: jede Ausnahme / fehlendes Cache-API → `false`. Der Aufrufer
 * unterscheidet „kein Cache-API" selbst (typeof caches) und navigiert dann
 * fail-open, statt den Nutzer schlechterzustellen.
 */
export async function isFormCached(url: string): Promise<boolean> {
  try {
    if (typeof caches === "undefined") return false;
    const names = (await caches.keys()).filter((k) => k.endsWith("-pages"));
    for (const name of names) {
      const cache = await caches.open(name);
      const hit = await cache.match(url, { ignoreSearch: true, ignoreVary: true });
      if (hit) return true;
    }
  } catch {
    // caches nicht verfügbar / Zugriff verweigert → wie „nicht gecacht"
  }
  return false;
}

function safeLocalStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Merkt: offline konnte keine Buchung erfasst werden (Formular nicht gecacht). */
export function markOfflineMiss(path: string): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    const miss: OfflineMiss = { at: Date.now(), path };
    ls.setItem(OFFLINE_MISS_KEY, JSON.stringify(miss));
  } catch {
    /* Quota/Privatmodus → ignorieren */
  }
}

/** Liest das Flag (oder null, wenn nicht gesetzt / unlesbar). */
export function readOfflineMiss(): OfflineMiss | null {
  const ls = safeLocalStorage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(OFFLINE_MISS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OfflineMiss> | null;
    if (parsed && typeof parsed.at === "number" && typeof parsed.path === "string") {
      return { at: parsed.at, path: parsed.path };
    }
    return null;
  } catch {
    return null;
  }
}

/** Löscht das Flag (clear-on-show). */
export function clearOfflineMiss(): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.removeItem(OFFLINE_MISS_KEY);
  } catch {
    /* ignorieren */
  }
}
