import Link from "next/link";
import { Euro, Users } from "lucide-react";
import { listTransactions } from "@/lib/queries/transactions";
import { getTrip, getTripMembers } from "@/lib/queries/trips";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { isAdmin } from "@/lib/auth/authz";
import { tripVocab } from "@/lib/trip-vocab";
import { FabAddTransaction } from "@/components/bottom-nav";
import { TransactionsList } from "./transactions-list";
import { PendingTransactions } from "./pending-transactions";

export default async function TransactionsListPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const initialQuery = typeof sp.q === "string" ? sp.q : "";
  const [txs, members, person, admin, trip] = await Promise.all([
    listTransactions(id),
    getTripMembers(id),
    getCurrentPerson(),
    isAdmin(),
    getTrip(id),
  ]);
  const vocab = tripVocab(trip?.trip_type);
  // canEdit-Check pro Row: Skipper / Co-Skipper / Admin / Ersteller.
  const myMember = members.find((m) => m.person_id === person?.id);
  const isMyTripSkipper = !!myMember?.is_skipper;
  // Ohne Crew lässt sich keine sinnvolle Buchung anlegen (kein „Bezahlt von",
  // keine Aufteilung). FAB + CTA daher nur mit Crew zeigen — sonst landet man
  // in einem Formular ohne wählbare Personen (Sackgasse).
  const hasMembers = members.length > 0;
  const memberNames = Object.fromEntries(members.map((m) => [m.person_id, m.display_name]));

  // pb-36: der FAB reicht bis ~136px über den unteren Rand (bottom-20 + h-14).
  // Die Liste braucht so viel Polster, damit der FAB die Edit-/Lösch-Icons der
  // untersten Buchung nicht überdeckt (U-1).
  return (
    <main className="mx-auto max-w-2xl px-4 pb-36 pt-4">
      {/* Noch nicht gesyncte Offline-Entwürfe (client-seitig aus IndexedDB). */}
      <PendingTransactions tripId={id} memberNames={memberNames} />

      {!hasMembers ? (
        <div className="rounded-lg border border-dashed border-rule p-10 text-center">
          <Users className="mx-auto mb-3 h-10 w-10 text-ink-soft" />
          <p className="font-medium">Noch keine {vocab.crew}</p>
          <p className="mt-1 text-sm text-ink-soft">
            Lege zuerst die {vocab.crew} an, danach kannst du Ausgaben erfassen und auf
            die {vocab.crew} aufteilen.
          </p>
          <Link
            href={`/trips/${id}/settings`}
            className="mt-4 inline-flex min-h-touch items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-paper hover:bg-navy-dark"
          >
            {vocab.crew} hinzufügen
          </Link>
        </div>
      ) : txs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-rule p-10 text-center">
          <Euro className="mx-auto mb-3 h-10 w-10 text-ink-soft" />
          <p className="font-medium">Noch keine Buchung</p>
          <p className="mt-1 text-sm text-ink-soft">
            Tippe auf das ➕ unten rechts, um die erste Ausgabe zu erfassen.
          </p>
        </div>
      ) : (
        <TransactionsList
          tripId={id}
          rows={txs}
          currentPersonId={person?.id ?? null}
          isMyTripSkipper={isMyTripSkipper}
          isAdmin={admin}
          initialQuery={initialQuery}
        />
      )}

      {hasMembers && <FabAddTransaction tripId={id} />}
    </main>
  );
}
