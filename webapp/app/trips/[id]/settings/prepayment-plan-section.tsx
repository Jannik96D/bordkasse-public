import Link from "next/link";
import { Coins } from "lucide-react";
import { InfoTooltip } from "@/components/info-tooltip";
import { setPrepaymentDeclined } from "@/lib/actions/trips";
import { tripVocab, type TripType } from "@/lib/trip-vocab";

/**
 * Einstieg in den Anzahlungs-Wizard aus den Trip-Einstellungen heraus (D).
 * Der bestehende Short-Cut auf der Anzahlungs-Seite („Plan bearbeiten")
 * bleibt unverändert — diese Section ist der zusätzliche, auffindbare Weg,
 * v. a. wenn der Plan (noch) nicht existiert oder der Törn schon läuft und
 * deshalb kein CTA mehr in der Übersicht steht.
 *
 * Zusätzlich lässt sich hier die Anlage-Entscheidung „mit/ohne Anzahlung"
 * umkehren (trips.prepayment_declined_at): „ohne" blendet den Übersichts-CTA
 * und das Checklisten-Item aus; ein existierender Plan gewinnt immer.
 *
 * Erscheint nur, wenn `canEdit` true ist (vom Settings-Page übernommen).
 */
export function PrepaymentPlanSection({
  tripId,
  planExists,
  declined = false,
  tripType = "sailing",
}: {
  tripId: string;
  planExists: boolean;
  declined?: boolean;
  tripType?: TripType;
}) {
  const vocab = tripVocab(tripType);
  const tripDem = vocab.trip === "Reise" ? "diese Reise" : "diesen Törn";
  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-primary">
        <Coins className="h-4 w-4" />
        Anzahlungsplan
        <InfoTooltip
          label="Was ist ein Anzahlungsplan?"
          text={`Für ${vocab.prepayment}en, die die vorstreckende Person Monate vor dem Törn ${tripType === "other" ? "an den Anbieter" : "an die Charteragentur"} leistet und sich von der ${vocab.crew} in Tranchen zurückerstatten lässt.`}
        />
      </h2>

      <div className="rounded-md border border-rule bg-paper p-4">
        <p className="text-sm text-ink-soft">
          {planExists
            ? `Aufteilung, ${vocab.cabinPlural} und Tranchen anpassen oder die vorstreckende Person ändern.`
            : declined
              ? `Für ${tripDem} ist keine Anzahlung vorgesehen — kein Hinweis auf der Übersicht, kein Punkt in der Fortschritt-Karte.`
              : `Lege fest, wie sich die ${vocab.prepayment} auf die ${vocab.crew} verteilt und in welchen Tranchen sie fällig wird.`}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Link
            href={`/trips/${tripId}/prepayments/setup`}
            className="inline-flex min-h-[44px] items-center gap-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-paper hover:bg-navy-dark"
          >
            {planExists
              ? "Anzahlungsplan bearbeiten"
              : declined
                ? "Doch Anzahlungsplan einrichten"
                : "Anzahlungsplan einrichten"}
          </Link>
          {/* Entscheidung umkehrbar machen — nur solange kein Plan existiert
              (mit Plan ist die Frage entschieden). */}
          {!planExists && !declined && (
            <form action={setPrepaymentDeclined.bind(null, tripId, true)}>
              <button
                type="submit"
                className="inline-flex min-h-[44px] items-center rounded-md border border-rule bg-paper px-4 py-2 text-sm font-medium text-ink-soft hover:border-primary/40 hover:text-primary"
              >
                Keine Anzahlung für {tripDem}
              </button>
            </form>
          )}
          {!planExists && declined && (
            <form action={setPrepaymentDeclined.bind(null, tripId, false)}>
              <button
                type="submit"
                className="inline-flex min-h-[44px] items-center rounded-md border border-rule bg-paper px-4 py-2 text-sm font-medium text-ink-soft hover:border-primary/40 hover:text-primary"
              >
                Anzahlung doch vorsehen
              </button>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
