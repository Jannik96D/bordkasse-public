import { BarChart3 } from "lucide-react";
import { getTripStats } from "@/lib/queries/stats";
import { getTripMembers } from "@/lib/queries/trips";
import { StatsView } from "./stats-view";

export default async function StatsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [stats, members] = await Promise.all([
    getTripStats(id),
    getTripMembers(id),
  ]);
  // Ghost-Member (per Skipper eingeladene, aber noch nicht angemeldete
  // Personen) zählen voll mit — sie sind reguläre Crew-Mitglieder, nur
  // ohne eigenen App-Login.
  const memberCount = members.length;

  if (stats.count === 0) {
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-8">
        <h1 className="text-2xl font-bold text-primary">Statistik</h1>
        <div className="mt-6 rounded-lg border border-rule bg-paper-soft p-8 text-center">
          <BarChart3 className="mx-auto mb-3 h-10 w-10 text-ink-soft" />
          <p className="font-medium">Noch keine Ausgaben</p>
          <p className="mt-1 text-sm text-ink-soft">
            Sobald die erste Buchung erfasst ist, siehst du hier die Verteilung
            nach Kategorie und Tag.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-bold text-primary">Statistik</h1>
      <p className="mt-1 text-sm text-ink-soft">Live-Auswertung der Ausgaben.</p>

      <StatsView tripId={id} stats={stats} memberCount={memberCount} />
    </main>
  );
}
