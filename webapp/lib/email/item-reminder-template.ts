/**
 * Mail-Templates für die automatischen Erinnerungen zu weiteren Zahlungen
 * (intern `item`; PR5, Migration 0061; PR7 auf das gemeinsame Gerüst
 * `payment-mail.ts` umgestellt):
 *
 *   • renderItemCrewReminderMail  (item_crew_3d)  — Crew-Person, offener Anteil
 *   • renderItemPayeeReminderMail (item_payee_3d) — vorstreckende Person: Übersicht
 *     Soll Anbieter / Crew-Eingänge / überwiesen / noch offen
 *
 * ⚠️ Escaping: Bezeichnung, Kategorie, Törnname und alle Namen sind frei
 * editierbarer Text → im HTML IMMER durch `escapeHtml` (Lehre aus
 * prepayment-notice-template, Fund 1 PR 6). Die Text-Variante bleibt roh.
 */

import { escapeHtml, fmtEuro } from "./mail-shell";
import { tripVocab } from "@/lib/trip-vocab";
import {
  advanceSubject,
  howToBlock,
  noteCard,
  renderPaymentMail,
  shareSubject,
  tripPhrase,
  type Block,
  type Fact,
} from "./payment-mail";

export interface ItemReminderItemInfo {
  label: string;
  /** Kategorie-Name (z. B. „An-/Abreise") oder null. */
  categoryName: string | null;
}

export interface ItemCrewReminderParams {
  recipientName: string;
  payeeName: string;
  tripName: string;
  tripType: "sailing" | "other";
  item: ItemReminderItemInfo;
  /** Formatierte Crewfrist (toCrewDueDate, „12.3.2027"). */
  crewDueDate: string;
  amountOpen: number;
  amountSoll: number;
  appUrl: string;
}

export interface ItemPayeeReminderParams {
  recipientName: string;
  tripName: string;
  tripType: "sailing" | "other";
  item: ItemReminderItemInfo;
  /** Formatierte Fälligkeit beim Anbieter. */
  providerDueDate: string;
  providerSoll: number;
  crewPaid: number;
  crewSoll: number;
  providerPaid: number;
  providerOpen: number;
  /** Eigener Anteil, der noch nicht per Selbstverrechnung erfasst ist. */
  ownOpen: number;
  appUrl: string;
}

const itemTitle = (i: ItemReminderItemInfo) => (i.categoryName ? `${i.categoryName}: ${i.label}` : i.label);

export function renderItemCrewReminderMail(p: ItemCrewReminderParams): { html: string; text: string; subject: string } {
  const title = itemTitle(p.item);
  const partly = Math.abs(p.amountSoll - p.amountOpen) > 0.005;
  const amountHtml = `${fmtEuro(p.amountOpen)}${partly ? ` <span style="color:#587EA8;">(von ${fmtEuro(p.amountSoll)})</span>` : ""}`;
  const amountText = `${fmtEuro(p.amountOpen)}${partly ? ` (von ${fmtEuro(p.amountSoll)})` : ""}`;
  const facts: Fact[] = [
    { label: "Dein Anteil", html: amountHtml, text: amountText, strong: true, color: "#114884" },
    { label: "Bis wann", html: `<strong>${escapeHtml(p.crewDueDate)}</strong>`, text: p.crewDueDate },
    { label: "An wen", html: `<strong>${escapeHtml(p.payeeName)}</strong>`, text: p.payeeName },
  ];
  return renderPaymentMail({
    subject: shareSubject({ what: p.item.label, amount: p.amountOpen, due: p.crewDueDate, isReminder: true }),
    headline: `Erinnerung: ${p.item.label}`,
    recipientName: p.recipientName,
    tripName: p.tripName,
    introHtml: `für ${tripPhrase(p.tripType)} <strong>${escapeHtml(p.tripName)}</strong> ist dein Anteil für <strong>${escapeHtml(title)}</strong> noch offen. Bitte überweise ihn bis <strong>${escapeHtml(p.crewDueDate)}</strong> an <strong>${escapeHtml(p.payeeName)}</strong>.`,
    introText: `für ${tripPhrase(p.tripType)} ${p.tripName} ist dein Anteil für ${title} noch offen. Bitte überweise ihn bis ${p.crewDueDate} an ${p.payeeName}.`,
    preheader: `Offen: ${fmtEuro(p.amountOpen)} für ${p.item.label} — bis ${p.crewDueDate}`,
    appUrl: p.appUrl,
    facts,
    how: howToBlock(
      `Schon gezahlt? Dann tippe in der App bei „${p.item.label}“ auf „Ich habe gezahlt“, damit ${p.payeeName} die Einzahlung bestätigen kann.`,
    ),
  });
}

export function renderItemPayeeReminderMail(p: ItemPayeeReminderParams): { html: string; text: string; subject: string } {
  const vocab = tripVocab(p.tripType);
  const title = itemTitle(p.item);
  const facts: Fact[] = [
    { label: "Du streckst vor", html: fmtEuro(p.providerSoll), text: fmtEuro(p.providerSoll), strong: true, color: "#114884" },
    { label: "Bis wann", html: `<strong>${escapeHtml(p.providerDueDate)}</strong>`, text: p.providerDueDate },
    { label: "An wen", html: "<strong>Anbieter</strong>", text: "Anbieter" },
    {
      label: `Von der ${vocab.crew} bei dir`,
      html: `${fmtEuro(p.crewPaid)} <span style="color:#587EA8;">von ${fmtEuro(p.crewSoll)}</span>`,
      text: `${fmtEuro(p.crewPaid)} von ${fmtEuro(p.crewSoll)}`,
    },
    { label: "An Anbieter überwiesen", html: fmtEuro(p.providerPaid), text: fmtEuro(p.providerPaid) },
    { label: "Noch zu überweisen", html: fmtEuro(p.providerOpen), text: fmtEuro(p.providerOpen), strong: true, color: "#A93226" },
  ];
  const extra: Block[] = [];
  if (p.ownOpen > 0.005) {
    const t = `Dein eigener Anteil (${fmtEuro(p.ownOpen)}) ist noch nicht als Selbstverrechnung erfasst. Trag ihn in der App bei „${p.item.label}“ ein, damit die Zahlung abgeschlossen werden kann.`;
    extra.push(noteCard(escapeHtml(t), t));
  }
  return renderPaymentMail({
    subject: advanceSubject({ what: p.item.label, amount: p.providerOpen, due: p.providerDueDate, isReminder: true }),
    headline: `Erinnerung: ${p.item.label}`,
    recipientName: p.recipientName,
    tripName: p.tripName,
    introHtml: `am <strong>${escapeHtml(p.providerDueDate)}</strong> ist <strong>${escapeHtml(title)}</strong> für ${tripPhrase(p.tripType)} <strong>${escapeHtml(p.tripName)}</strong> beim Anbieter fällig. Hier der aktuelle Stand.`,
    introText: `am ${p.providerDueDate} ist ${title} für ${tripPhrase(p.tripType)} ${p.tripName} beim Anbieter fällig. Hier der aktuelle Stand.`,
    preheader: `Noch ${fmtEuro(p.providerOpen)} an den Anbieter überweisen — ${p.item.label}`,
    appUrl: p.appUrl,
    facts,
    extra,
    how: howToBlock(
      "Sobald du an den Anbieter gezahlt hast, erfasse die Überweisung in der App bei der Karte unter „Überweisung an Anbieter erfassen“.",
    ),
  });
}
