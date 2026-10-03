/**
 * Mails zu Einzahlungen für weitere Zahlungen (intern `item`, PR6/PR7) —
 * Pendant zu payment-pending-template (Selbstmeldung) und
 * prepayment-notice-template (Erfassung/Bestätigung/Ablehnung) des
 * Anzahlungsplans, mit der Sache beim Namen („An-/Abreise: Flüge") statt
 * „N. Anzahlung". Beide laufen über das gemeinsame Gerüst `payment-mail.ts`.
 *
 *   • renderItemPendingMail — an die vorstreckende Person: X meldet eine Einzahlung.
 *   • renderItemNoticeMail  — Info an zahlende bzw. vorstreckende Person.
 *
 * ⚠️ Escaping: Bezeichnung, Kategorie, Törnname, Notiz und alle Namen sind
 * frei editierbar → im HTML IMMER durch escapeHtml. Die Text-Variante bleibt
 * roh (Plaintext). Wero kommt in diesen Mails bewusst nicht vor (es geht um
 * eine bereits geleistete Zahlung).
 */

import { escapeHtml, fmtEuro } from "./mail-shell";
import { tripVocab } from "@/lib/trip-vocab";
import type { ItemNoticeKind } from "@/lib/prepayments/notify";
import {
  EVENT_WORD,
  PAYMENT_STATUS,
  eventSubject,
  howToBlock,
  noteCard,
  renderPaymentMail,
  type Block,
  type Fact,
  type PaymentEventKind,
} from "./payment-mail";

export interface ItemMailInfo {
  label: string;
  categoryName: string | null;
}

export const itemMailTitle = (i: ItemMailInfo): string => (i.categoryName ? `${i.categoryName}: ${i.label}` : i.label);

export interface ItemPendingParams {
  recipientName: string;
  reporterName: string;
  tripName: string;
  tripType: "sailing" | "other";
  item: ItemMailInfo;
  amount: number;
  /** Formatiertes Zahlungsdatum laut Meldung. */
  date: string;
  note?: string | null;
  appUrl: string;
  /**
   * Gesetzt, wenn die Mail stellvertretend an Skipper/Co-Skipper geht, weil
   * die vorstreckende Person (Name hier) keine E-Mail-Adresse hinterlegt hat.
   */
  onBehalfOfName?: string;
}

export function renderItemPendingMail(p: ItemPendingParams): { html: string; text: string; subject: string } {
  const title = itemMailTitle(p.item);
  const subject = eventSubject({ what: p.item.label, kind: "pending", who: p.reporterName, amount: p.amount });
  const facts: Fact[] = [
    { label: "Was", html: escapeHtml(title), text: title },
    { label: "Von", html: `<strong>${escapeHtml(p.reporterName)}</strong>`, text: p.reporterName },
    { label: "Betrag", html: fmtEuro(p.amount), text: fmtEuro(p.amount), strong: true, color: "#114884" },
    { label: "Gezahlt am", html: escapeHtml(p.date), text: p.date },
    { label: "Status", html: escapeHtml(PAYMENT_STATUS.pending), text: PAYMENT_STATUS.pending },
  ];
  const extra: Block[] = [];
  if (p.note) {
    extra.push(noteCard(`<strong>Notiz von ${escapeHtml(p.reporterName)}:</strong> ${escapeHtml(p.note)}`, `Notiz von ${p.reporterName}: ${p.note}`));
  }
  return renderPaymentMail({
    subject,
    headline: "Einzahlung gemeldet",
    recipientName: p.recipientName,
    tripName: p.tripName,
    introHtml: `<strong>${escapeHtml(p.reporterName)}</strong> meldet, den Anteil für <strong>${escapeHtml(title)}</strong> an ${p.onBehalfOfName ? `<strong>${escapeHtml(p.onBehalfOfName)}</strong>` : "dich"} gezahlt zu haben.`,
    introText: `${p.reporterName} meldet, den Anteil für ${title} an ${p.onBehalfOfName ?? "dich"} gezahlt zu haben.`,
    preheader: `${p.reporterName} meldet ${fmtEuro(p.amount)} für ${p.item.label} — bitte bestätigen.`,
    appUrl: p.appUrl,
    facts,
    extra,
    how: howToBlock("Bestätige die Meldung in der App, sobald das Geld angekommen ist — oder lehne sie ab. Vorher zählt sie nicht."),
    hint: p.onBehalfOfName
      ? `Du bekommst diese Mail stellvertretend, weil ${p.onBehalfOfName} keine E-Mail-Adresse hinterlegt hat. Bitte kläre mit ${p.onBehalfOfName}, ob das Geld angekommen ist.`
      : "Du bekommst diese Mail, weil du hier vorstreckst und das Geld an dich geht.",
  });
}

export interface ItemNoticeParams {
  kind: ItemNoticeKind;
  /** Rolle des EMPFÄNGERS dieser Mail. */
  role: "payer" | "payee";
  recipientName: string;
  actorName: string;
  payerName: string;
  payeeName: string;
  tripName: string;
  tripType: "sailing" | "other";
  item: ItemMailInfo;
  amount: number;
  appUrl: string;
}

const KIND_MAP: Record<ItemNoticeKind, PaymentEventKind> = {
  item_payment_recorded: "recorded",
  item_payment_confirmed: "confirmed",
  item_payment_rejected: "rejected",
};

export function renderItemNoticeMail(p: ItemNoticeParams): { html: string; text: string; subject: string } {
  const vocab = tripVocab(p.tripType);
  const title = itemMailTitle(p.item);
  const a = escapeHtml(p.actorName);
  const eTitle = escapeHtml(title);
  const amount = fmtEuro(p.amount);
  const isPayer = p.role === "payer";
  const event = KIND_MAP[p.kind];
  // „deine Einzahlung" für die zahlende Person, sonst „die Einzahlung von X".
  const whoseHtml = isPayer ? "deine Einzahlung" : `die Einzahlung von ${escapeHtml(p.payerName)}`;
  const whoseText = isPayer ? "deine Einzahlung" : `die Einzahlung von ${p.payerName}`;

  let headline: string;
  let introHtml: string;
  let introText: string;
  let accent = "#1E8449";
  switch (p.kind) {
    case "item_payment_recorded":
      headline = "Einzahlung erfasst";
      introHtml = `${a} hat ${whoseHtml} über ${amount} für <strong>${eTitle}</strong> in der ${vocab.kitty} erfasst.`;
      introText = `${p.actorName} hat ${whoseText} über ${amount} für ${title} in der ${vocab.kitty} erfasst.`;
      break;
    case "item_payment_confirmed":
      headline = "Einzahlung bestätigt";
      introHtml = `${a} hat ${whoseHtml} über ${amount} für <strong>${eTitle}</strong> bestätigt. Sie zählt ab jetzt.`;
      introText = `${p.actorName} hat ${whoseText} über ${amount} für ${title} bestätigt. Sie zählt ab jetzt.`;
      break;
    case "item_payment_rejected":
      headline = "Einzahlung abgelehnt";
      introHtml = `${a} hat ${isPayer ? "deine Meldung" : `die Meldung von ${escapeHtml(p.payerName)}`} über ${amount} für <strong>${eTitle}</strong> abgelehnt.`;
      introText = `${p.actorName} hat ${isPayer ? "deine Meldung" : `die Meldung von ${p.payerName}`} über ${amount} für ${title} abgelehnt.`;
      accent = "#A93226";
      break;
  }

  const followup =
    p.kind === "item_payment_rejected"
      ? isPayer
        ? `Der Anteil ist damit wieder offen. Falls die Ablehnung ein Versehen war, sprich kurz mit ${p.payeeName} — du kannst die Einzahlung danach erneut melden.`
        : "Der Anteil ist damit wieder offen."
      : `Falls etwas nicht stimmt, sprich kurz mit ${isPayer ? p.payeeName : p.actorName} — Einzahlungen lassen sich in der App korrigieren.`;

  const facts: Fact[] = [
    { label: "Was", html: eTitle, text: title },
    { label: "Von", html: `<strong>${escapeHtml(p.payerName)}</strong>`, text: p.payerName },
    { label: "An wen", html: `<strong>${escapeHtml(p.payeeName)}</strong>`, text: p.payeeName },
    { label: "Betrag", html: amount, text: amount, strong: true, color: "#114884" },
    { label: "Status", html: escapeHtml(EVENT_WORD[event]), text: EVENT_WORD[event] },
  ];
  const hint = isPayer
    ? `Du bekommst diese Mail, weil ${p.actorName} eine Aktion zu deiner Einzahlung ausgelöst hat.`
    : `Du bekommst diese Mail, weil du hier vorstreckst und ${p.actorName} eine Aktion dazu ausgelöst hat.`;

  return renderPaymentMail({
    subject: eventSubject({ what: p.item.label, kind: event, who: p.payerName, amount: p.amount }),
    headline,
    recipientName: p.recipientName,
    tripName: p.tripName,
    introHtml,
    introText,
    preheader: `${p.actorName}: ${p.payerName} · ${title} · ${amount}`,
    appUrl: p.appUrl,
    facts,
    accent,
    how: howToBlock(followup),
    hint,
  });
}
