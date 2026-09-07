/**
 * Draft-Kennung fürs Offline-Bearbeiten (Fund 2, PR 5) — lebt im URL-FRAGMENT
 * (`#draft=<id>`), NICHT im Query-String (`?draft=<id>`).
 *
 * Grund: `/trips/[id]/transactions/new` ist eine Server Component, die
 * offline über den Service Worker ausgeliefert wird. `networkFirst` in
 * `public/sw.js` fällt bei einem Cache-Miss für `…/new?draft=X` per
 * `ignoreSearch` auf das vorgewärmte, QUERY-FREIE Dokument `…/new` zurück —
 * der Server-Render, den der Browser dabei bekommt, wurde also nie mit
 * `draft` als `searchParams` erzeugt. Ein Query-Parameter ist offline damit
 * strukturell unzuverlässig. Das Fragment erreicht den Server nie — weder als
 * Teil des HTTP-Requests noch des Service-Worker-Cache-Keys — und lässt sich
 * rein client-seitig nach dem Laden auslesen.
 */

/** Baut den Bearbeiten-Link für einen Outbox-Entwurf. */
export function draftEditHref(tripId: string, draftId: string): string {
  return `/trips/${tripId}/transactions/new#draft=${encodeURIComponent(draftId)}`;
}

/** Liest `#draft=<id>` aus `window.location.hash`, sonst `null`. */
export function readDraftIdFromHash(hash: string): string | null {
  const match = /^#draft=(.+)$/.exec(hash);
  return match ? decodeURIComponent(match[1]) : null;
}
