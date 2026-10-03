/**
 * HTML- und Text-Template für die Erinnerungs-Mail zum Anzahlungsplan (Crew).
 * Layout über das gemeinsame Gerüst `payment-mail.ts` — identisch zu den
 * Erinnerungen für weitere Zahlungen.
 *
 * Spec: docs/prepayments.md §Erinnerungsmail
 */

import { escapeHtml, fmtEuro } from "./mail-shell";
import { tripVocab } from "@/lib/trip-vocab";
import { normalizeWeroId } from "@/lib/prepayments/notify";
import { howToPayBlock, renderPaymentMail, shareSubject, tripPhrase, type Fact } from "./payment-mail";

export type ReminderTrancheItem = {
  label: string;
  due_date: string;       // formatiert "15.07.2026"
  amount_due: number;     // verbleibender Restbetrag
  amount_total: number;   // Gesamtsoll der Person für diese Tranche
};

export type PrepaymentReminderParams = {
  recipientName: string;
  tripName: string;
  tranches: ReminderTrancheItem[];
  weroId?: string | null;
  /** Anzeigename der Person, an die die Crew zahlt (vorstreckende Person — Default = Skipper). */
  advancerName: string;
  appUrl: string;
  /** Reise-Typ — steuert das Vokabular (Bordkasse/Törn vs. Urlaubskasse/Reise). */
  tripType: "sailing" | "other";
};

export function renderPrepaymentReminderMail(p: PrepaymentReminderParams): {
  html: string;
  text: string;
  subject: string;
} {
  const vocab = tripVocab(p.tripType);
  // Wero-Regel (PR6, Entscheidung Nutzer): ohne Wero-ID (leer/Whitespace)
  // erwähnt die Mail Wero mit keinem Wort — weder Block noch Hinweistext.
  const weroId = normalizeWeroId(p.weroId);
  const totalOpen = p.tranches.reduce((s, t) => s + t.amount_due, 0);

  const rateHtml = p.tranches
    .map(
      (t) =>
        `<strong>${escapeHtml(t.label)}</strong> bis ${escapeHtml(t.due_date)}: offen ${fmtEuro(t.amount_due)}${
          t.amount_total !== t.amount_due ? ` <span style="color:#587EA8;">(von ${fmtEuro(t.amount_total)})</span>` : ""
        }`,
    )
    .join("<br/>");
  const rateText = p.tranches
    .map((t) => `  - ${t.label} bis ${t.due_date}: offen ${fmtEuro(t.amount_due)}${t.amount_total !== t.amount_due ? ` (von ${fmtEuro(t.amount_total)})` : ""}`)
    .join("\n");

  const facts: Fact[] = [
    { label: "Dein Anteil", html: `${fmtEuro(totalOpen)} offen`, text: `${fmtEuro(totalOpen)} offen`, strong: true, color: "#114884" },
    { label: "Bis wann", html: rateHtml, text: rateText },
    { label: "An wen", html: `<strong>${escapeHtml(p.advancerName)}</strong>`, text: p.advancerName },
  ];

  return renderPaymentMail({
    subject: shareSubject({ what: vocab.prepayment, amount: totalOpen, due: p.tranches[0]?.due_date ?? null, isReminder: true }),
    headline: `Erinnerung: ${vocab.prepayment}`,
    recipientName: p.recipientName,
    tripName: p.tripName,
    introHtml: `hier deine offenen Raten der ${escapeHtml(vocab.prepayment)} für ${tripPhrase(p.tripType)} <strong>${escapeHtml(p.tripName)}</strong>. Insgesamt offen: <strong>${fmtEuro(totalOpen)}</strong>.`,
    introText: `hier deine offenen Raten der ${vocab.prepayment} für ${tripPhrase(p.tripType)} ${p.tripName}. Insgesamt offen: ${fmtEuro(totalOpen)}.`,
    preheader: `Offene ${vocab.prepayment}: ${fmtEuro(totalOpen)} für ${p.tripName}`,
    appUrl: p.appUrl,
    facts,
    how: howToPayBlock({ payeeName: p.advancerName, weroId, purpose: `Anzahlung ${p.tripName}` }),
    hint: weroId
      ? "Wero bietet aktuell keine öffentliche Schnittstelle für Klick-Links. Bitte die Wero-ID in deiner Wero-App als Empfänger eingeben und Betrag + Verwendungszweck manuell übernehmen."
      : null,
  });
}
