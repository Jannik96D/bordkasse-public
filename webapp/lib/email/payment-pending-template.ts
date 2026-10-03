/**
 * Mail an die vorstreckende Person, wenn ein Crewmitglied eine Einzahlung
 * zum Anzahlungsplan selbst meldet.
 *
 * Spec: docs/prepayments.md §Phase 2.
 * Layout über das gemeinsame Gerüst `payment-mail.ts` (identisch zu den
 * Mails für weitere Zahlungen).
 */

import { escapeHtml, fmtEuro } from "./mail-shell";
import { tripVocab } from "@/lib/trip-vocab";
import {
  PAYMENT_STATUS,
  eventSubject,
  howToBlock,
  noteCard,
  renderPaymentMail,
  type Block,
  type Fact,
} from "./payment-mail";

export type PaymentPendingParams = {
  /** Empfänger der Mail — typischerweise die vorstreckende Person (Default = Skipper). */
  skipperName: string;
  reporterName: string;
  tripName: string;
  trancheLabel: string;
  trancheDueDate: string;   // "15.07.2026"
  amount: number;
  note?: string | null;
  appUrl: string;          // Link auf /trips/{id}/prepayments
  /** Reise-Typ — steuert das Vokabular (Bordkasse/Törn/Crewbilanz vs. Urlaubskasse/Reise/Gruppenbilanz). */
  tripType: "sailing" | "other";
};

export function renderPaymentPendingMail(p: PaymentPendingParams): {
  html: string;
  text: string;
  subject: string;
} {
  const vocab = tripVocab(p.tripType);
  const what = `${vocab.prepayment} (${p.trancheLabel})`;
  const facts: Fact[] = [
    { label: "Was", html: escapeHtml(what), text: what },
    { label: "Von", html: `<strong>${escapeHtml(p.reporterName)}</strong>`, text: p.reporterName },
    { label: "Betrag", html: fmtEuro(p.amount), text: fmtEuro(p.amount), strong: true, color: "#114884" },
    { label: "Fällig", html: escapeHtml(p.trancheDueDate), text: p.trancheDueDate },
    { label: "Status", html: escapeHtml(PAYMENT_STATUS.pending), text: PAYMENT_STATUS.pending },
  ];
  const extra: Block[] = [];
  if (p.note) {
    extra.push(noteCard(`<strong>Notiz von ${escapeHtml(p.reporterName)}:</strong> ${escapeHtml(p.note)}`, `Notiz von ${p.reporterName}: ${p.note}`));
  }
  return renderPaymentMail({
    subject: eventSubject({ what, kind: "pending", who: p.reporterName, amount: p.amount }),
    headline: "Einzahlung gemeldet",
    recipientName: p.skipperName,
    tripName: p.tripName,
    introHtml: `<strong>${escapeHtml(p.reporterName)}</strong> hat eine Einzahlung zur ${escapeHtml(vocab.prepayment)} gemeldet.`,
    introText: `${p.reporterName} hat eine Einzahlung zur ${vocab.prepayment} gemeldet.`,
    preheader: `${p.reporterName} hat ${fmtEuro(p.amount)} gemeldet — bitte bestätigen.`,
    appUrl: p.appUrl,
    facts,
    extra,
    how: howToBlock("Bestätige die Meldung in der App, sobald das Geld auf deinem Konto angekommen ist — oder lehne sie ab. Vorher zählt sie nicht."),
    hint: `Du bekommst diese Mail, weil du für ${p.tripType === "other" ? "diese Reise" : "diesen Törn"} vorstreckst. Ohne Bestätigung zählt die Einzahlung nicht zur ${p.tripType === "other" ? "Bilanz der Reisegruppe" : "Crewbilanz"}.`,
  });
}
