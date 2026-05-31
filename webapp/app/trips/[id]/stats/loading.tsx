/** Lade-Skeleton für die Statistik-Seite (Balken-Diagramm). */
export default function Loading() {
  return (
    <main className="mx-auto max-w-2xl px-4 pb-24 pt-4" aria-hidden="true">
      <div className="mb-4 h-6 w-28 animate-pulse rounded bg-navy-light" />
      <div className="mb-6 grid grid-cols-2 gap-3">
        <div className="h-20 animate-pulse rounded-lg bg-paper-soft" />
        <div className="h-20 animate-pulse rounded-lg bg-paper-soft" />
      </div>
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="space-y-1">
            <div className="h-3 w-24 animate-pulse rounded bg-navy-light/70" />
            <div
              className="h-5 animate-pulse rounded bg-navy-light/50"
              style={{ width: `${90 - i * 15}%` }}
            />
          </div>
        ))}
      </div>
      <span className="sr-only">Statistik wird geladen …</span>
    </main>
  );
}
