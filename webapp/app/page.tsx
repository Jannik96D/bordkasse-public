import Link from "next/link";
import { Plus, Anchor, Archive } from "lucide-react";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { listMyTrips } from "@/lib/queries/trips";
import { formatDate } from "@/lib/utils";

export default async function Home() {
  const person = await getCurrentPerson();

  if (!person) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
        <div className="max-w-md space-y-6">
          <div className="text-5xl">⚓</div>
          <h1 className="text-4xl font-bold text-primary">Bordkasse</h1>
          <p className="text-lg text-ink-soft">
            Faire Kostenaufteilung auf Segel-Törns mit wechselnden Crews.
          </p>
          <Link
            href="/login"
            className="inline-flex items-center justify-center rounded-md bg-primary px-6 py-3 font-medium text-paper transition-colors hover:bg-navy-dark"
          >
            Anmelden
          </Link>
        </div>
      </main>
    );
  }

  const trips = await listMyTrips();
  const active = trips.filter((t) => !t.archived);
  const archived = trips.filter((t) => t.archived);

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-primary">Meine Törns</h1>
          <p className="mt-1 text-sm text-ink-soft">
            Willkommen, <span className="font-medium text-ink">{person.display_name}</span>
          </p>
        </div>
        <Link
          href="/profile"
          className="text-sm text-ink-soft hover:text-primary"
        >
          Profil
        </Link>
      </header>

      <Link
        href="/trips/new"
        className="mb-6 flex items-center justify-center gap-2 rounded-md border-2 border-dashed border-primary/30 bg-navy-light/30 px-4 py-4 font-medium text-primary transition-colors hover:bg-navy-light/50"
      >
        <Plus className="h-5 w-5" />
        Neuen Törn anlegen
      </Link>

      {active.length > 0 ? (
        <ul className="space-y-3">
          {active.map((t) => <TripCard key={t.id} trip={t} />)}
        </ul>
      ) : (
        <div className="rounded-lg border border-rule bg-paper-soft p-8 text-center">
          <Anchor className="mx-auto mb-3 h-10 w-10 text-ink-soft" />
          <p className="font-medium">Noch kein aktiver Törn</p>
          <p className="mt-1 text-sm text-ink-soft">
            Leg deinen ersten Törn an oder lass dich einladen.
          </p>
        </div>
      )}

      {archived.length > 0 && (
        <details className="mt-10 group">
          <summary className="cursor-pointer text-sm font-medium text-ink-soft hover:text-ink">
            <Archive className="inline h-4 w-4 mr-1" />
            Archiv ({archived.length})
          </summary>
          <ul className="mt-3 space-y-2 opacity-60">
            {archived.map((t) => <TripCard key={t.id} trip={t} />)}
          </ul>
        </details>
      )}

      <p className="mt-12 text-center text-xs text-ink-soft">
        <Link href="/datenschutz" className="hover:text-primary">Datenschutz</Link>
      </p>
    </main>
  );
}

function TripCard({ trip }: { trip: Awaited<ReturnType<typeof listMyTrips>>[number] }) {
  return (
    <li>
      <Link
        href={`/trips/${trip.id}`}
        className="block rounded-md border border-rule bg-paper p-4 transition-colors hover:border-primary/40 hover:bg-navy-light/20"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-primary">{trip.name}</p>
            <p className="mt-1 text-sm text-ink-soft">
              {formatDate(trip.start_date)} – {formatDate(trip.end_date)}
            </p>
            {trip.ship_name && (
              <p className="mt-1 text-xs text-ink-soft">{trip.ship_name}</p>
            )}
          </div>
          <div className="text-right">
            <p className="text-sm text-ink-soft">{trip.member_count} Crew</p>
            {trip.is_skipper && (
              <span className="mt-1 inline-block rounded-full bg-gold-soft px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gold">
                Skipper
              </span>
            )}
          </div>
        </div>
      </Link>
    </li>
  );
}
