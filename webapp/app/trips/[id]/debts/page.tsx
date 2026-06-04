import { ArrowRight } from "lucide-react";
import { getSimplifiedDebts } from "@/lib/queries/balances";
import { getSettledDebtKeys, debtKey } from "@/lib/queries/settled-debts";
import { getTrip, getTripMembers } from "@/lib/queries/trips";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { isAdmin } from "@/lib/auth/authz";
import { formatEuro } from "@/lib/utils";
import { tripVocab } from "@/lib/trip-vocab";
import { SettlementStatus } from "@/components/settlement-status";
import { InfoTooltip } from "@/components/info-tooltip";
import { DebtCheckbox } from "./debt-checkbox";

export default async function DebtsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [debts, settled, trip, members, person, admin] = await Promise.all([
    getSimplifiedDebts(id),
    getSettledDebtKeys(id),
    getTrip(id),
    getTripMembers(id),
    getCurrentPerson(),
    isAdmin(),
  ]);

  const isMyTripSkipper = !!members.find((m) => m.person_id === person?.id)?.is_skipper;
  const canAnnounce = admin || isMyTripSkipper;
  const settlementAnnounced = !!trip?.settlement_announced_at;
  const vocab = tripVocab(trip?.trip_type);

  if (debts.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10 text-center">
        <div className="text-3xl mb-3">🎉</div>
        <p className="font-medium">Alles ausgeglichen</p>
        <p className="mt-1 text-sm text-ink-soft">
          Keine offenen Schulden: entweder noch nichts erfasst oder alle Salden = 0.
        </p>
      </main>
    );
  }

  const total = debts.reduce((a, d) => a + d.amount, 0);
  const settledCount = debts.filter((d) =>
    settled.has(debtKey(d.from_person_id, d.to_person_id, d.amount)),
  ).length;
  const openCount = debts.length - settledCount;

  return (
    <main className="mx-auto max-w-2xl px-4 pb-24 pt-4">
      {trip && (
        <SettlementStatus
          tripId={id}
          endDate={trip.end_date}
          announcedAt={trip.settlement_announced_at ?? null}
          changesPendingSince={trip.changes_pending_since ?? null}
          lastResendAt={trip.last_settlement_resend_at ?? null}
          canAnnounce={canAnnounce}
          vocab={vocab}
        />
      )}
      <header className="mb-4">
        <h1 className="text-lg font-bold text-primary">
          Schulden
          <InfoTooltip
            label="Wie funktionieren die Bezahlt-Häkchen?"
            text={`Das Bezahlt-Häkchen wird in der ganzen ${vocab.crew} geteilt, alle sehen denselben Stand live. Kommt eine neue Buchung dazu, ändert sich der Betrag — das alte Häkchen wird dann automatisch zurückgesetzt, weil die Schuld neu berechnet wird.`}
          />
        </h1>
        <p className="mt-1 text-xs text-ink-soft">
          {debts.length} Überweisungen · gesamt {formatEuro(total)}
          {settledCount > 0 && (
            <>
              {" · "}
              <span className="text-success">{settledCount} erledigt</span>
              {", "}
              {openCount} offen
            </>
          )}
        </p>
      </header>

      <ul className="space-y-2">
        {debts.map((d, idx) => {
          const isSettled = settled.has(
            debtKey(d.from_person_id, d.to_person_id, d.amount),
          );
          return (
            <li
              key={`${d.from_person_id}-${d.to_person_id}-${idx}`}
              className={
                isSettled
                  ? "flex items-center gap-3 rounded-md border border-rule bg-paper-soft p-3 opacity-60"
                  : "flex items-center gap-3 rounded-md border border-rule bg-paper p-3"
              }
            >
              <DebtCheckbox
                tripId={id}
                fromPersonId={d.from_person_id}
                toPersonId={d.to_person_id}
                amount={d.amount}
                initialSettled={isSettled}
                canToggle={
                  settlementAnnounced &&
                  (admin ||
                    person?.id === d.from_person_id ||
                    person?.id === d.to_person_id)
                }
              />
              <div className="flex flex-1 items-center gap-2">
                <span className={isSettled ? "font-medium line-through" : "font-medium"}>
                  {d.from_name}
                </span>
                <ArrowRight className="h-4 w-4 text-ink-soft" />
                <span className={isSettled ? "font-medium line-through" : "font-medium"}>
                  {d.to_name}
                </span>
              </div>
              <span
                className={
                  isSettled
                    ? "font-semibold tabular-nums text-ink-soft line-through"
                    : "font-semibold tabular-nums text-primary"
                }
              >
                {formatEuro(d.amount)}
              </span>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
