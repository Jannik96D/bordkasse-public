import Link from "next/link";
import { Coins } from "lucide-react";
import { InfoTooltip } from "@/components/info-tooltip";
import { tripVocab, type TripType } from "@/lib/trip-vocab";

/**
 * Einstieg in den Anzahlungs-Wizard aus den Trip-Einstellungen heraus (D).
 * Der bestehende Short-Cut auf der Anzahlungs-Seite („Plan bearbeiten")
 * bleibt unverändert — diese Section ist der zusätzliche, auffindbare Weg,
 * v. a. wenn der Plan (noch) nicht existiert oder der Törn schon läuft und
 * deshalb kein CTA mehr in der Übersicht steht.
 *
 * Erscheint nur, wenn `canEdit` true ist (vom Settings-Page übernommen).
 */
export function PrepaymentPlanSection({
  tripId,
  planExists,
  tripType = "sailing",
}: {
  tripId: string;
  planExists: boolean;
  tripType?: TripType;
}) {
  const vocab = tripVocab(tripType);
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
            : `Lege fest, wie sich die ${vocab.prepayment} auf die ${vocab.crew} verteilt und in welchen Tranchen sie fällig wird.`}
        </p>
        <Link
          href={`/trips/${tripId}/prepayments/setup`}
          className="mt-3 inline-flex min-h-[44px] items-center gap-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-paper hover:bg-navy-dark"
        >
          {planExists ? "Anzahlungsplan bearbeiten" : "Anzahlungsplan einrichten"}
        </Link>
      </div>
    </section>
  );
}
