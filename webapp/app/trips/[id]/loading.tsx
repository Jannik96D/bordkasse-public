/**
 * Lade-Skeleton für die Trip-Routen. Das Trip-Layout lädt seine Daten
 * blockierend (await Promise.all([...])); dieses Skeleton überbrückt die
 * Wartezeit bei schwachem Bord-Netz, statt einen leeren Bildschirm zu zeigen.
 */
export default function Loading() {
  // Container identisch zur Übersichts-Page (`mx-auto max-w-2xl px-4 py-6`),
  // damit das Skeleton beim Tab-Wechsel nicht von links-bündig (full-width)
  // auf zentriert springt. Dient zugleich als zentrierter Fallback für
  // Kind-Routen ohne eigenes loading.tsx (settings, prepayments).
  return (
    <main className="mx-auto max-w-2xl animate-pulse px-4 py-6" aria-hidden="true">
      <div className="mb-6 h-7 w-2/3 rounded bg-navy-light" />
      <div className="space-y-3">
        <div className="h-16 rounded-lg bg-paper-soft" />
        <div className="h-16 rounded-lg bg-paper-soft" />
        <div className="h-16 rounded-lg bg-paper-soft" />
      </div>
      <span className="sr-only">Wird geladen …</span>
    </main>
  );
}
