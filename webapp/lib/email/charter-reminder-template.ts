/**
 * Mail an die vorstreckende Person — Erinnerung an die ANSTEHENDE eigene
 * Überweisung an den Anbieter. Wird ausgelöst entweder vom Cron (3 Tage vor
 * der Frist) oder manuell vom 🔔-Button in der Matrix-Zeile.
 *
 * Per Rate zeigen wir:
 *   - Soll Anbieter                    = totalAmount × percent / 100
 *   - von der Crew bei dir eingegangen = was die Crew bisher gezahlt hat
 *   - an Anbieter überwiesen           = expense-Buchung mit dieser Tranche
 *   - noch zu überweisen               = soll − bereits überwiesen
 *
 * Layout über das gemeinsame Gerüst `payment-mail.ts`.
 */

import { escapeHtml, fmtEuro } from "./mail-shell";
import { tripVocab } from "@/lib/trip-vocab";
import { advanceSubject, howToBlock, renderPaymentMail, type Block, type Fact } from "./payment-mail";

export type CharterReminderTranche = {
  label: string;
  charter_due_date: string;        // formatiert "15.07.2026"
  soll_to_agency: number;          // Soll des Anbieters (für diese Tranche)
  crew_paid_to_advancer: number;   // Σ Crewbeiträge bei dir
  crew_total_due: number;          // Σ Crewsoll (zum Vergleich)
  paid_to_agency: number;          // schon an den Anbieter überwiesen
  remaining_to_agency: number;     // noch offen
};

export type CharterReminderParams = {
  recipientName: string;           // = vorstreckende Person
  tripName: string;
  tranches: CharterReminderTranche[];
  appUrl: string;
  /** true = ausgelöst vom Cron (3 Tage vor Frist); false = manuell. */
  isAutomated?: boolean;
  /** Reise-Typ — steuert das Vokabular (Yachtanzahlung vs. Urlaubsanzahlung). */
  tripType: "sailing" | "other";
};

export function renderCharterReminderMail(p: CharterReminderParams): {
  html: string;
  text: string;
  subject: string;
} {
  const vocab = tripVocab(p.tripType);
  const totalRemaining = p.tranches.reduce((s, t) => s + Math.max(0, t.remaining_to_agency), 0);
  const totalSoll = p.tranches.reduce((s, t) => s + t.soll_to_agency, 0);
  const totalCrewPaid = p.tranches.reduce((s, t) => s + t.crew_paid_to_advancer, 0);
  const totalCrewDue = p.tranches.reduce((s, t) => s + t.crew_total_due, 0);
  const totalPaidToProvider = p.tranches.reduce((s, t) => s + t.paid_to_agency, 0);
  const nextOpen = p.tranches.find((t) => t.remaining_to_agency > 0.005) ?? p.tranches[0];
  const done = totalRemaining <= 0.005;

  // „Überfällig" nur wenn das Datum strikt in der Vergangenheit liegt —
  // am Stichtag selbst zählt es noch nicht als verpasst.
  const rateHtml = p.tranches
    .map((t) => {
      const overdue = t.remaining_to_agency > 0.005 && isDueInPast(t.charter_due_date);
      const rest = Math.max(0, t.remaining_to_agency);
      return `<strong>${escapeHtml(t.label)}</strong> bis ${escapeHtml(t.charter_due_date)}: ${
        rest > 0.005 ? `noch ${fmtEuro(rest)} von ${fmtEuro(t.soll_to_agency)}` : `${fmtEuro(t.soll_to_agency)} überwiesen`
      }${overdue ? ` <span style="color:#A93226;font-weight:600;">· überfällig</span>` : ""}`;
    })
    .join("<br/>");
  const rateText = p.tranches
    .map((t) => {
      const rest = Math.max(0, t.remaining_to_agency);
      const overdue = t.remaining_to_agency > 0.005 && isDueInPast(t.charter_due_date);
      return `  - ${t.label} bis ${t.charter_due_date}: ${
        rest > 0.005 ? `noch ${fmtEuro(rest)} von ${fmtEuro(t.soll_to_agency)}` : `${fmtEuro(t.soll_to_agency)} überwiesen`
      }${overdue ? " (überfällig)" : ""}`;
    })
    .join("\n");

  const facts: Fact[] = [
    { label: "Du streckst vor", html: fmtEuro(totalSoll), text: fmtEuro(totalSoll), strong: true, color: "#114884" },
    { label: "Bis wann", html: rateHtml, text: rateText },
    { label: "An wen", html: "<strong>Anbieter</strong>", text: "Anbieter" },
    {
      label: `Von der ${vocab.crew} bei dir`,
      html: `${fmtEuro(totalCrewPaid)} <span style="color:#587EA8;">von ${fmtEuro(totalCrewDue)}</span>`,
      text: `${fmtEuro(totalCrewPaid)} von ${fmtEuro(totalCrewDue)}`,
    },
    { label: "An Anbieter überwiesen", html: fmtEuro(totalPaidToProvider), text: fmtEuro(totalPaidToProvider) },
    {
      label: "Noch zu überweisen",
      html: fmtEuro(totalRemaining),
      text: fmtEuro(totalRemaining),
      strong: true,
      color: done ? "#1E8449" : "#A93226",
    },
  ];
  const extra: Block[] = [];

  return renderPaymentMail({
    subject: advanceSubject({
      what: vocab.prepayment,
      amount: totalSoll,
      due: nextOpen?.charter_due_date ?? null,
      isReminder: !!p.isAutomated,
    }),
    headline: p.isAutomated ? `${vocab.prepayment} steht an` : `${vocab.prepayment} – Übersicht`,
    recipientName: p.recipientName,
    tripName: p.tripName,
    introHtml: escapeHtml(
      p.isAutomated
        ? "in den nächsten Tagen wird deine Anzahlung an den Anbieter fällig. Hier eine Übersicht, was bei dir ankommt und was du noch überweisen musst."
        : "hier dein aktueller Stand für die Anzahlung an den Anbieter: was bei dir ankommt und was du noch überweisen musst.",
    ),
    introText: p.isAutomated
      ? "in den nächsten Tagen wird deine Anzahlung an den Anbieter fällig. Hier eine Übersicht, was bei dir ankommt und was du noch überweisen musst."
      : "hier dein aktueller Stand für die Anzahlung an den Anbieter: was bei dir ankommt und was du noch überweisen musst.",
    preheader: done
      ? `Alle Raten der ${vocab.prepayment} für ${p.tripName} sind vollständig überwiesen.`
      : `Noch ${fmtEuro(totalRemaining)} an den Anbieter überweisen — ${p.tripName}`,
    appUrl: p.appUrl,
    facts,
    extra,
    how: howToBlock(
      "Sobald du an den Anbieter überwiesen hast, erfasse die Überweisung als neue Ausgabe und ordne sie der passenden Rate zu — sie taucht dann hier korrekt auf.",
    ),
  });
}

/** True wenn das formatierte Datum „d.m.yyyy" strikt vor heute liegt. */
function isDueInPast(dueDate: string): boolean {
  if (!dueDate) return false;
  const parts = dueDate.split(".");
  if (parts.length !== 3) return false;
  const [dStr, mStr, yStr] = parts;
  const due = new Date(`${yStr}-${mStr.padStart(2, "0")}-${dStr.padStart(2, "0")}T00:00:00Z`);
  if (Number.isNaN(due.getTime())) return false;
  const nowIso = new Date().toISOString().slice(0, 10);
  const now = new Date(`${nowIso}T00:00:00Z`);
  return due.getTime() < now.getTime();
}
