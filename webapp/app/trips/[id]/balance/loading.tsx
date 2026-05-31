/** Lade-Skeleton für die Bilanz-Seite (Tabellen-Form). */
export default function Loading() {
  return (
    <main className="mx-auto max-w-2xl px-4 pb-24 pt-4" aria-hidden="true">
      <div className="mb-4 h-6 w-24 animate-pulse rounded bg-navy-light" />
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center justify-between rounded-md bg-paper-soft px-3 py-3"
          >
            <div className="h-4 w-28 animate-pulse rounded bg-navy-light/70" />
            <div className="h-4 w-16 animate-pulse rounded bg-navy-light/70" />
          </div>
        ))}
      </div>
      <span className="sr-only">Bilanz wird geladen …</span>
    </main>
  );
}
