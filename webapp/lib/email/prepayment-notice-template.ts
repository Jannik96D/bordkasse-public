/**
 * Generische Info-Mail für Aktionen zum Anzahlungsplan, die von einer DRITTEN
 * Person (Admin, Co-Skipper, vorstreckende Person) ausgelöst werden — und über
 * die der Betroffene normalerweise informiert werden sollte.
 *
 * Drei Varianten (`kind`):
 *   - "payment_recorded"  → Eine Einzahlung wurde im Namen von X erfasst.
 *                           Empfänger: die Crewperson UND die vorstreckende
 *                           Person (sofern Actor ≠ vorstreckende Person).
 *   - "payment_confirmed" → Eine Selbstmeldung von X wurde bestätigt.
 *   - "payment_rejected"  → Eine Selbstmeldung von X wurde abgelehnt.
 *
 * Layout über das gemeinsame Gerüst `payment-mail.ts`.
 */

import { escapeHtml, fmtEuro } from "./mail-shell";
import { tripVocab } from "@/lib/trip-vocab";
import {
  EVENT_WORD,
  eventSubject,
  howToBlock,
  renderPaymentMail,
  type Fact,
  type PaymentEventKind,
} from "./payment-mail";

export type PrepaymentNoticeKind = "payment_recorded" | "payment_confirmed" | "payment_rejected";

export type PrepaymentNoticeParams = {
  kind: PrepaymentNoticeKind;
  recipientName: string;
  actorName: string;
  /** Name der Crewperson, um die es bei der Buchung geht. */
  subjectPersonName: string;
  /** Optional: Name der vorstreckenden Person, wenn der Empfänger nicht selbst vorstreckt. */
  advancerName?: string;
  amount: number;
  trancheLabel: string;
  tripName: string;
  appUrl: string;
  /** Reise-Typ — steuert das Vokabular (Bordkasse/Skipper vs. Urlaubskasse/Reiseleitung). */
  tripType: "sailing" | "other";
};

const KIND_MAP: Record<PrepaymentNoticeKind, PaymentEventKind> = {
  payment_recorded: "recorded",
  payment_confirmed: "confirmed",
  payment_rejected: "rejected",
};

export function renderPrepaymentNoticeMail(p: PrepaymentNoticeParams): {
  html: string;
  text: string;
  subject: string;
} {
  const vocab = tripVocab(p.tripType);
  // Dativ für „sprich mit … oder {…}" — Segeltörn „dem Skipper", sonst
  // „der Reiseleitung".
  const skipperDative = p.tripType === "other" ? "der Reiseleitung" : "dem Skipper";
  const event = KIND_MAP[p.kind];
  const what = `${vocab.prepayment} (${p.trancheLabel})`;
  const amount = fmtEuro(p.amount);
  const a = escapeHtml(p.actorName);
  const s = escapeHtml(p.subjectPersonName);
  const t = escapeHtml(p.trancheLabel);

  let headline: string;
  let introHtml: string;
  let introText: string;
  let accent = "#587EA8";

  switch (p.kind) {
    case "payment_recorded": {
      headline = "Einzahlung erfasst";
      const self = p.recipientName === p.subjectPersonName;
      introHtml = self
        ? `${a} hat soeben eine Einzahlung in Höhe von ${amount} für ${t} im Namen von dir erfasst.`
        : `${a} hat soeben eine Einzahlung von ${s} in Höhe von ${amount} für ${t} in der ${vocab.kitty} erfasst.`;
      introText = self
        ? `${p.actorName} hat soeben eine Einzahlung in Höhe von ${amount} für ${p.trancheLabel} im Namen von dir erfasst.`
        : `${p.actorName} hat soeben eine Einzahlung von ${p.subjectPersonName} in Höhe von ${amount} für ${p.trancheLabel} in der ${vocab.kitty} erfasst.`;
      accent = "#1E8449";
      break;
    }
    case "payment_confirmed":
      headline = "Einzahlung bestätigt";
      introHtml = `${a} hat soeben die Meldung von ${s} in Höhe von ${amount} für ${t} bestätigt.`;
      introText = `${p.actorName} hat soeben die Meldung von ${p.subjectPersonName} in Höhe von ${amount} für ${p.trancheLabel} bestätigt.`;
      accent = "#1E8449";
      break;
    case "payment_rejected":
      headline = "Einzahlung abgelehnt";
      introHtml = `${a} hat soeben die Meldung von ${s} in Höhe von ${amount} für ${t} abgelehnt.`;
      introText = `${p.actorName} hat soeben die Meldung von ${p.subjectPersonName} in Höhe von ${amount} für ${p.trancheLabel} abgelehnt.`;
      accent = "#A93226";
      break;
  }

  const followupText =
    p.kind === "payment_rejected"
      ? `Falls die Ablehnung ein Versehen war, sprich kurz mit der vorstreckenden Person oder ${skipperDative}, die Einzahlung kann neu erfasst werden.`
      : `Falls etwas nicht stimmt, sprich kurz mit der vorstreckenden Person oder ${skipperDative}, Einzahlungen können in der App noch geändert werden.`;

  const facts: Fact[] = [
    { label: "Was", html: escapeHtml(what), text: what },
    { label: "Von", html: `<strong>${s}</strong>`, text: p.subjectPersonName },
    { label: "Betrag", html: amount, text: amount, strong: true, color: "#114884" },
    { label: "Status", html: escapeHtml(EVENT_WORD[event]), text: EVENT_WORD[event] },
  ];

  return renderPaymentMail({
    subject: eventSubject({ what, kind: event, who: p.subjectPersonName, amount: p.amount }),
    headline,
    recipientName: p.recipientName,
    tripName: p.tripName,
    introHtml,
    introText,
    preheader: `${p.actorName}: ${p.subjectPersonName} · ${p.trancheLabel} · ${amount}`,
    appUrl: p.appUrl,
    facts,
    accent,
    how: howToBlock(followupText),
    hint: p.advancerName
      ? `Du bekommst diese Mail, weil ${p.advancerName} für ${p.tripType === "other" ? "diese Reise" : "diesen Törn"} vorstreckt und ${p.actorName} eine Aktion zu deiner Einzahlung ausgelöst hat.`
      : `Du bekommst diese Mail, weil die Einzahlungen an dich gehen (du streckst für ${p.tripType === "other" ? "diese Reise" : "diesen Törn"} vor). Aktionen anderer Personen — wie ${p.actorName} hier — landen automatisch bei dir.`,
  });
}
