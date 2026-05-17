import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { SettlementAnnounceButton } from "./settlement-announce-button";

/**
 * Zeigt den Stand der Trip-Abrechnung als Banner:
 *
 * 1. Törn läuft noch (Stichtag in der Zukunft) → kein Banner.
 * 2. Törn vorbei + nicht angekündigt + Skipper/Admin → "Bitte Kaution prüfen
 *    und Abrechnung verschicken" mit Button.
 * 3. Törn vorbei + nicht angekündigt + Crew → "Skipper schließt die Bordkasse
 *    gerade ab, bitte warten".
 * 4. Angekündigt → grüner "Abrechnung steht"-Hinweis mit Datum.
 *
 * Wird sowohl in der Trip-Übersicht als auch in der Schulden-Seite
 * eingebunden, damit der Hinweis sichtbar ist, wo er gebraucht wird.
 */
export function SettlementStatus({
  tripId,
  endDate,
  announcedAt,
  canAnnounce,
}: {
  tripId: string;
  endDate: string;
  announcedAt: string | null;
  /** true = User darf den "Abrechnung verschicken"-Button drücken (Skipper/Admin). */
  canAnnounce: boolean;
}) {
  if (announcedAt) {
    return (
      <div className="mb-4 flex items-start gap-2 rounded-md border border-success/30 bg-success/5 p-3 text-sm">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
        <p>
          <span className="font-medium text-success">Abrechnung verschickt</span>{" "}
          <span className="text-ink-soft">am {formatDate(announcedAt.slice(0, 10))}.</span>{" "}
          <span className="text-ink-soft">Bezahlt-Häkchen sind freigeschaltet.</span>
        </p>
      </div>
    );
  }

  // Törn läuft noch? Dann gibt's noch nichts zu tun.
  const todayIso = new Date().toISOString().slice(0, 10);
  if (todayIso <= endDate) return null;

  if (canAnnounce) {
    return (
      <div className="mb-4 rounded-md border border-gold/30 bg-gold-soft p-3 text-sm">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-gold" aria-hidden />
          <div className="flex-1">
            <p className="font-medium text-primary">Törn vorbei — Abrechnung verschicken?</p>
            <p className="mt-1 text-xs text-ink-soft">
              Bitte prüfe nochmal, ob die Kaution-Buchung noch aktuell ist (Restbetrag,
              Schäden o.ä.). Sobald du auf „Abrechnung verschicken“ drückst,
              bekommt jedes Crew-Mitglied eine Mail mit seiner Bilanz und kann
              Zahlungen abhaken.
            </p>
            <SettlementAnnounceButton tripId={tripId} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4 flex items-start gap-2 rounded-md border border-rule bg-paper-soft p-3 text-sm">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-soft" aria-hidden />
      <p className="text-ink-soft">
        Der Törn ist vorbei — der Skipper prüft gerade die offenen Buchungen
        (z.B. Kaution-Rückzahlung). Sobald die Abrechnung verschickt ist,
        kannst du deine Zahlung in der App als erledigt markieren.
      </p>
    </div>
  );
}
