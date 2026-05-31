/**
 * Lade-Skeleton für die Buchungs-Liste. Ohne dieses File fiel die
 * Buchungen-Route auf das Übersichts-Skeleton (`trips/[id]/loading.tsx`)
 * zurück — andere Form + (vor dem Fix) links-bündig statt zentriert. Container
 * identisch zur Buchungs-Page (`mx-auto max-w-2xl px-4 pb-24 pt-4`).
 */
export default function Loading() {
  return (
    <main className="mx-auto max-w-2xl px-4 pb-24 pt-4" aria-hidden="true">
      <div className="mb-4 h-6 w-32 animate-pulse rounded bg-navy-light" />
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center justify-between rounded-md border border-rule px-3 py-3"
          >
            <div className="space-y-2">
              <div className="h-4 w-36 animate-pulse rounded bg-navy-light/70" />
              <div className="h-3 w-24 animate-pulse rounded bg-navy-light/40" />
            </div>
            <div className="h-4 w-16 animate-pulse rounded bg-navy-light/70" />
          </div>
        ))}
      </div>
      <span className="sr-only">Buchungen werden geladen …</span>
    </main>
  );
}
