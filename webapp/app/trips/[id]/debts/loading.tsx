/** Lade-Skeleton für die Schuldenseite (Überweisungs-Liste). */
export default function Loading() {
  return (
    <main className="mx-auto max-w-2xl px-4 pb-24 pt-4" aria-hidden="true">
      <div className="mb-4 h-6 w-28 animate-pulse rounded bg-navy-light" />
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-3 rounded-md border border-rule px-3 py-3"
          >
            <div className="h-4 w-20 animate-pulse rounded bg-navy-light/70" />
            <div className="h-4 w-4 animate-pulse rounded-full bg-navy-light/70" />
            <div className="h-4 w-20 animate-pulse rounded bg-navy-light/70" />
            <div className="ml-auto h-4 w-14 animate-pulse rounded bg-navy-light/70" />
          </div>
        ))}
      </div>
      <span className="sr-only">Schulden werden geladen …</span>
    </main>
  );
}
