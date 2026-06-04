import { AlertTriangle, CheckCircle2, Info, RefreshCw } from "lucide-react";
import { formatDate } from "@/lib/utils";
import type { TripVocab } from "@/lib/trip-vocab";
import { SettlementAnnounceButton } from "./settlement-announce-button";
import { SettlementResendButton } from "./settlement-resend-button";

/**
 * Zeigt den Stand der Trip-Abrechnung als Banner:
 *
 * 1. Törn läuft noch (Stichtag in der Zukunft) → kein Banner.
 * 2. Törn vorbei + nicht angekündigt + Skipper/Admin → "Bitte Kaution prüfen
 *    und Abrechnung verschicken" mit Button.
 * 3. Törn vorbei + nicht angekündigt + Crew → "Skipper schließt die Bordkasse
 *    gerade ab, bitte warten".
 * 4. Angekündigt + keine offenen Änderungen → grüner "Abrechnung steht"-Hinweis.
 * 5. Angekündigt + changesPendingSince gesetzt → gelber „Bilanz aktualisiert
 *    — Update verschicken?"-Hinweis mit Button. Jedes Crew-Mitglied darf den
 *    Button drücken, typischerweise die Person, die soeben eine nachträgliche
 *    Buchung erfasst hat.
 *
 * Wird sowohl in der Trip-Übersicht als auch in der Schulden-Seite
 * eingebunden, damit der Hinweis sichtbar ist, wo er gebraucht wird.
 */
export function SettlementStatus({
  tripId,
  endDate,
  announcedAt,
  changesPendingSince = null,
  lastResendAt = null,
  canAnnounce,
  highlight = false,
  vocab,
}: {
  tripId: string;
  endDate: string;
  announcedAt: string | null;
  /** Zeitstempel der ersten Buchungs-Änderung seit dem letzten Mailversand. */
  changesPendingSince?: string | null;
  /** Zeitstempel der letzten Update-Mail (für „zuletzt aktualisiert am …"). */
  lastResendAt?: string | null;
  /** true = User darf den "Abrechnung verschicken"-Button drücken (Skipper/Admin). */
  canAnnounce: boolean;
  /** true = nach Kaution-Edit/-Delete; Hinweis wird prominenter dargestellt. */
  highlight?: boolean;
  /** Reise-typ-abhängiges Vokabular (vom aufrufenden Server-Component gereicht). */
  vocab: TripVocab;
}) {
  if (announcedAt) {
    if (changesPendingSince) {
      // Jedes Crew-Mitglied darf den Resend auslösen — bewusst kein
      // canAnnounce-Gate. Wer nachträglich etwas eingetragen hat, soll die
      // Update-Mail direkt selbst raushauen können, statt den Skipper zu
      // bitten. Server-Action prüft Member-Status nochmal serverseitig.
      return (
        <div className="mb-4 rounded-md border border-gold/30 bg-gold-soft p-3 text-sm">
          <div className="flex items-start gap-2">
            <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-gold" aria-hidden />
            <div className="flex-1">
              <p className="font-medium text-primary">
                Bilanz hat sich seit der Abrechnung geändert
              </p>
              <p className="mt-1 text-xs text-ink-soft">
                Buchungen wurden seit dem letzten Mailversand am{" "}
                {formatDate((lastResendAt ?? announcedAt).slice(0, 10))} aktualisiert.
                Verschicke eine Update-Mail, damit alle die neue Bilanz sehen.
              </p>
              <SettlementResendButton tripId={tripId} />
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="mb-4 flex items-start gap-2 rounded-md border border-success/30 bg-success/5 p-3 text-sm">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
        <p>
          <span className="font-medium text-success">Abrechnung verschickt</span>{" "}
          <span className="text-ink-soft">
            am {formatDate((lastResendAt ?? announcedAt).slice(0, 10))}.
          </span>{" "}
          <span className="text-ink-soft">Bezahlt-Häkchen sind freigeschaltet.</span>
        </p>
      </div>
    );
  }

  // Banner ab dem letzten Trip-Tag (heute >= end_date − 1 Tag), damit der
  // Skipper schon am Ende des Törns abschließen kann, ohne bis zum nächsten
  // Tag warten zu müssen.
  const todayIso = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(endDate);
  cutoff.setDate(cutoff.getDate() - 1);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  if (todayIso < cutoffIso) return null;

  if (canAnnounce) {
    const headline = highlight
      ? `Kaution-Buchung aktualisiert — ${vocab.kitty} jetzt zur Abrechnung freigeben?`
      : `${vocab.trip} vorbei — Abrechnung verschicken?`;
    // Kurzer Standard-Hinweis im Banner; die ausführliche Erklärung (was
    // passiert beim Versand, Kaution-Hinweis) steckt im Aufklapper darunter.
    const subline = highlight
      ? "Letzte Kaution-Buchung gerade angepasst — jetzt verschicken?"
      : "Vorab kurz prüfen, ob die Kaution-Buchung schon final ist.";
    return (
      <div className={
        highlight
          ? "mb-4 rounded-md border-2 border-primary bg-gold-soft p-4 text-sm shadow-sm"
          : "mb-4 rounded-md border border-gold/30 bg-gold-soft p-3 text-sm"
      }>
        <div className="flex items-start gap-2">
          <AlertTriangle className={
            highlight
              ? "mt-0.5 h-5 w-5 shrink-0 text-primary"
              : "mt-0.5 h-4 w-4 shrink-0 text-gold"
          } aria-hidden />
          <div className="flex-1">
            <p className="font-medium text-primary">{headline}</p>
            <p className="mt-1 text-xs text-ink-soft">{subline}</p>
            <SettlementAnnounceButton tripId={tripId} />
            <details className="mt-2 group">
              <summary className="cursor-pointer list-none text-xs text-primary hover:underline">
                <span className="group-open:hidden">Was passiert beim Verschicken? ›</span>
                <span className="hidden group-open:inline">‹ Schließen</span>
              </summary>
              <p className="mt-1 text-xs text-ink-soft">
                Jedes {vocab.member} bekommt eine Mail mit der eigenen Bilanz und dem Zahlungsplan. Häkchen für „bezahlt“ sind danach in der App freigeschaltet. Bei späteren Buchungs-Änderungen kannst du eine Update-Mail nachschicken.
              </p>
            </details>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4 flex items-start gap-2 rounded-md border border-rule bg-paper-soft p-3 text-sm">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-soft" aria-hidden />
      <p className="text-ink-soft">
        {vocab.trip === "Reise" ? "Die Reise ist" : "Der Törn ist"} vorbei — {vocab.skipper === "Skipper" ? "dein Skipper" : "deine Reiseleitung"} prüft gerade die offenen Buchungen
        (z.B. Kaution-Rückzahlung). Sobald die Abrechnung verschickt ist,
        kannst du deine Zahlung in der App als erledigt markieren.
      </p>
    </div>
  );
}
