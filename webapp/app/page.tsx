import Image from "next/image";
import Link from "next/link";
import { Plus, Anchor, Archive, AlertTriangle, BarChart3 } from "lucide-react";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { isAdmin } from "@/lib/auth/authz";
import { listMyTrips } from "@/lib/queries/trips";
import { formatDate } from "@/lib/utils";
import { InstallHint } from "@/components/install-hint";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ account_deleted?: string }>;
}) {
  const person = await getCurrentPerson();
  const admin = await isAdmin();
  const sp = await searchParams;
  const justDeleted = sp.account_deleted === "1";

  if (!person) {
    return (
      <main className="flex flex-1 flex-col items-center px-6 pb-12 pt-[14vh] text-center">
        <div className="w-full max-w-md space-y-6">
          {justDeleted && (
            <div className="rounded-md border border-success/30 bg-success/5 p-3 text-sm text-success">
              Konto wurde gelöscht. Bis dann!
            </div>
          )}
          {/* Feste Box reserviert den Platz vor dem Laden → kein Layout-Shift (CLS). */}
          <div className="mx-auto h-[148px] w-48">
            <Image
              src="/logo.png"
              alt="Bordkasse"
              width={192}
              height={148}
              priority
              className="h-full w-full"
            />
          </div>
          <h1 className="text-4xl font-bold text-primary">Bordkasse</h1>
          <p className="text-lg text-ink-soft">
            Faire Kostenaufteilung auf Segeltörns – auch wenn die Crew wechselt.
          </p>
          <Link
            href="/login"
            className="inline-flex items-center justify-center rounded-md bg-primary px-6 py-3 font-medium text-paper transition-colors hover:bg-navy-dark"
          >
            Anmelden
          </Link>
          <p className="text-sm text-ink-soft">
            <Link href="/about" className="inline-block py-2 underline hover:text-primary">
              Über die Bordkassen-App
            </Link>
          </p>
          <div className="text-left">
            <InstallHint />
          </div>
        </div>
      </main>
    );
  }

  const trips = await listMyTrips();
  const myActive = trips.filter((t) => !t.archived && t.is_member);
  const myArchived = trips.filter((t) => t.archived && t.is_member);
  const adminOnlyActive = trips.filter((t) => !t.archived && !t.is_member);
  const adminOnlyArchived = trips.filter((t) => t.archived && !t.is_member);

  // DSGVO-Pending: nur Trips, für die der User auch berechtigt ist zu handeln
  // (eigene Skipper-Trips oder als Admin alle). Crew-only-Mitglieder sehen
  // den Banner nicht — sie können eh nicht löschen.
  const overdueTrips = trips.filter(
    (t) => t.retention_overdue && (admin || t.is_skipper),
  );

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

      <InstallHint />

      {overdueTrips.length > 0 && (
        <div
          className="mb-6 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 p-3 text-sm"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger" aria-hidden />
          <div className="flex-1">
            <p className="font-medium text-danger">
              DSGVO-Frist abgelaufen: {overdueTrips.length} Törn
              {overdueTrips.length === 1 ? "" : "s"} mit überfälligen Daten
            </p>
            <p className="mt-1 text-xs text-ink-soft">
              {overdueTrips.length === 1 ? "Dieser Törn ist" : "Diese Törns sind"} seit
              über 30 Tagen vorbei, aber personenbezogene Daten sind noch nicht gelöscht.
              Bitte Abrechnung verschicken, offene Zahlungen abhaken und im Törn-Settings
              auf „DSGVO-Löschung“ tippen.
            </p>
          </div>
        </div>
      )}

      {admin && (
        <Link
          href="/trips/new"
          className="mb-6 flex items-center justify-center gap-2 rounded-md border-2 border-dashed border-primary/30 bg-navy-light/30 px-4 py-4 font-medium text-primary transition-colors hover:bg-navy-light/50"
        >
          <Plus className="h-5 w-5" />
          Neuen Törn anlegen
        </Link>
      )}

      {myActive.length > 0 ? (
        <ul className="space-y-3">
          {myActive.map((t) => <TripCard key={t.id} trip={t} canAct={admin || t.is_skipper} />)}
        </ul>
      ) : (
        <div className="rounded-lg border border-rule bg-paper-soft p-8 text-center">
          <Anchor className="mx-auto mb-3 h-10 w-10 text-ink-soft" />
          <p className="font-medium">Noch kein aktiver Törn</p>
          <p className="mt-1 text-sm text-ink-soft">
            {admin
              ? "Leg deinen ersten Törn an oder lass dich einladen."
              : "Du wirst zu einem Törn eingeladen, sobald dein Skipper dich aufgenommen hat."}
          </p>
        </div>
      )}

      {myArchived.length > 0 && (
        <details className="mt-10 group">
          <summary className="cursor-pointer text-sm font-medium text-ink-soft hover:text-ink">
            <Archive className="inline h-4 w-4 mr-1" />
            Archiv ({myArchived.length})
          </summary>
          <ul className="mt-3 space-y-2 opacity-60">
            {myArchived.map((t) => <TripCard key={t.id} trip={t} canAct={admin || t.is_skipper} />)}
          </ul>
        </details>
      )}

      {admin && (adminOnlyActive.length > 0 || adminOnlyArchived.length > 0) && (
        <section className="mt-12 border-t border-rule pt-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-soft">
            Andere Törns · Admin-Ansicht
          </h2>
          {adminOnlyActive.length > 0 && (
            <ul className="space-y-3">
              {adminOnlyActive.map((t) => <TripCard key={t.id} trip={t} canAct={admin} />)}
            </ul>
          )}
          {adminOnlyArchived.length > 0 && (
            <details className="mt-6 group">
              <summary className="cursor-pointer text-sm font-medium text-ink-soft hover:text-ink">
                <Archive className="inline h-4 w-4 mr-1" />
                Archivierte fremde Törns ({adminOnlyArchived.length})
              </summary>
              <ul className="mt-3 space-y-2 opacity-60">
                {adminOnlyArchived.map((t) => <TripCard key={t.id} trip={t} canAct={admin} />)}
              </ul>
            </details>
          )}
        </section>
      )}

      {(admin || trips.length > 0) && (
        <div className="mt-10 border-t border-rule pt-6">
          <Link
            href="/stats"
            className="flex items-center justify-center gap-2 rounded-md border border-rule bg-paper px-4 py-3 text-sm font-medium text-ink transition-colors hover:border-primary/40 hover:bg-navy-light/20"
          >
            <BarChart3 className="h-4 w-4 text-primary" />
            Gesamtstatistik
          </Link>
        </div>
      )}

      <p className="mt-8 text-center text-xs text-ink-soft">
        <Link href="/about" className="inline-block py-2 hover:text-primary">Über die App</Link>
        <span className="mx-2">·</span>
        <Link href="/datenschutz" className="inline-block py-2 hover:text-primary">Datenschutz</Link>
        <span className="mx-2">·</span>
        <Link href="/kontakt" className="inline-block py-2 hover:text-primary">Kontakt</Link>
      </p>
    </main>
  );
}

/**
 * Törn-Status aus Start-/End-Datum ableiten (Vergleich auf ISO-Datum,
 * Server-Komponente → `new Date()` unbedenklich). Liefert Label + Stil für
 * ein kleines Badge, damit man bei mehreren Törns sofort sieht, welcher
 * läuft / ansteht / vorbei ist (U-3). Farbe ist NIE alleiniger Träger —
 * das Label trägt die Information.
 */
function tripStatus(startDate: string, endDate: string): { label: string; className: string } {
  const today = new Date().toISOString().slice(0, 10);
  if (endDate < today) {
    return { label: "Vorbei", className: "bg-paper-soft text-ink-soft" };
  }
  if (startDate > today) {
    return { label: "Anstehend", className: "bg-navy-light text-primary" };
  }
  return { label: "Läuft", className: "bg-success/10 text-success" };
}

function TripCard({
  trip,
  canAct,
}: {
  trip: Awaited<ReturnType<typeof listMyTrips>>[number];
  canAct: boolean;
}) {
  // Rote Markierung nur, wenn der angemeldete User auch handeln kann.
  const flagOverdue = canAct && trip.retention_overdue;
  const status = tripStatus(trip.start_date, trip.end_date);
  return (
    <li>
      <Link
        href={`/trips/${trip.id}`}
        className={
          flagOverdue
            ? "block rounded-md border-2 border-danger bg-danger/5 p-4 transition-colors hover:bg-danger/10"
            : "block rounded-md border border-rule bg-paper p-4 transition-colors hover:border-primary/40 hover:bg-navy-light/20"
        }
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold text-primary">{trip.name}</p>
              <span
                className={`inline-block shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${status.className}`}
              >
                {status.label}
              </span>
            </div>
            <p className="mt-1 text-sm text-ink-soft">
              {formatDate(trip.start_date)} – {formatDate(trip.end_date)}
            </p>
            {trip.ship_name && (
              <p className="mt-1 text-xs text-ink-soft">{trip.ship_name}</p>
            )}
            {flagOverdue && (
              <p className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-danger">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                DSGVO-Frist abgelaufen: Bitte löschen
              </p>
            )}
          </div>
          <div className="text-right">
            <p className="text-sm text-ink-soft">{trip.member_count} Crew</p>
            {trip.is_skipper ? (
              <span className="mt-1 inline-block rounded-full bg-navy-light px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                Skipper
              </span>
            ) : !trip.is_member ? (
              <span className="mt-1 inline-block rounded-full bg-paper-soft px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-soft">
                fremd
              </span>
            ) : null}
          </div>
        </div>
      </Link>
    </li>
  );
}
