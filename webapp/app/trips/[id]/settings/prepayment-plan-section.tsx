import Link from "next/link";
import { Coins } from "lucide-react";
import { InfoTooltip } from "@/components/info-tooltip";

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
}: {
  tripId: string;
  planExists: boolean;
}) {
  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-primary">
        <Coins className="h-4 w-4" />
        Anzahlungs-Plan
        <InfoTooltip
          label="Was ist ein Anzahlungs-Plan?"
          text="Für Yacht-Anzahlungen, die die vorstreckende Person Monate vor dem Törn an die Charteragentur leistet und sich von der Crew in Tranchen zurückerstatten lässt."
        />
      </h2>

      <div className="rounded-md border border-rule bg-paper p-4">
        <p className="text-sm text-ink-soft">
          {planExists
            ? "Aufteilung, Kojen und Tranchen anpassen oder die vorstreckende Person ändern."
            : "Lege fest, wie sich die Yacht-Anzahlung auf die Crew verteilt und in welchen Tranchen sie fällig wird."}
        </p>
        <Link
          href={`/trips/${tripId}/prepayments/setup`}
          className="mt-3 inline-flex min-h-[44px] items-center gap-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-paper hover:bg-navy-dark"
        >
          {planExists ? "Anzahlungs-Plan bearbeiten" : "Anzahlungs-Plan einrichten"}
        </Link>
      </div>
    </section>
  );
}
