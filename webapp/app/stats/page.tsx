import { BarChart3 } from "lucide-react";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { isAdmin } from "@/lib/auth/authz";
import { getGlobalStats } from "@/lib/queries/global-stats";
import { GlobalStatsView } from "./global-stats-view";

/**
 * Gesamt-Statistik: aggregiert alle Trips, die der User sehen darf.
 *
 * - Regulärer User: seine aktiven Trips (per RLS) + seine gepurgten Trips
 *   (per audience-Policy aus Migration 0020).
 * - Admin: alle Trips.
 *
 * Wenn `count === 0`, zeigen wir einen Empty-State statt der vier
 * Sections — das passiert für Brand-New User ohne Trip-Mitgliedschaft.
 */
export default async function GlobalStatsPage() {
  const person = await getCurrentPerson();
  if (!person) {
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-8">
        <h1 className="text-2xl font-bold text-primary">Gesamt-Statistik</h1>
        <p className="mt-4 text-sm text-ink-soft">
          Bitte zuerst{" "}
          <a href="/login" className="text-primary underline">
            anmelden
          </a>
          .
        </p>
      </main>
    );
  }

  const [stats, admin] = await Promise.all([getGlobalStats(), isAdmin()]);

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-bold text-primary">Gesamt-Statistik</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Alle Törns, in denen du Mitglied warst oder bist.
      </p>

      {stats.tripCount === 0 ? (
        <div className="mt-6 rounded-lg border border-rule bg-paper-soft p-8 text-center">
          <BarChart3 className="mx-auto mb-3 h-10 w-10 text-ink-soft" />
          <p className="font-medium">Noch keine Daten</p>
          <p className="mt-1 text-sm text-ink-soft">
            Sobald du in einem Törn als Crew dabei bist und die ersten
            Buchungen erfasst sind, erscheinen hier deine Gesamtausgaben.
          </p>
        </div>
      ) : (
        <GlobalStatsView stats={stats} admin={admin} />
      )}
    </main>
  );
}
