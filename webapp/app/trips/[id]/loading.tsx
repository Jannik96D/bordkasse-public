/**
 * Lade-Skeleton für die Trip-Routen. Das Trip-Layout lädt seine Daten
 * blockierend (await Promise.all([...])); dieses Skeleton überbrückt die
 * Wartezeit bei schwachem Bord-Netz, statt einen leeren Bildschirm zu zeigen.
 */
export default function Loading() {
  return (
    <div className="animate-pulse px-4 py-6" aria-hidden="true">
      <div className="mb-6 h-7 w-2/3 rounded bg-navy-light" />
      <div className="space-y-3">
        <div className="h-16 rounded-lg bg-paper-soft" />
        <div className="h-16 rounded-lg bg-paper-soft" />
        <div className="h-16 rounded-lg bg-paper-soft" />
      </div>
      <span className="sr-only">Wird geladen …</span>
    </div>
  );
}
