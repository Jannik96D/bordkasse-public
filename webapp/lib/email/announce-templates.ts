/**
 * „Neu angelegt"- und „hat sich geändert"-Mails für weitere Zahlungen (intern
 * `item`) und den Anzahlungsplan (PR6, PR7 vereinheitlicht). Alle Mails laufen
 * über das gemeinsame Gerüst `payment-mail.ts` (Betreff „{Was}: dein Anteil
 * {Betrag} bis {Datum}", Blöcke „Dein Anteil · Bis wann · An wen · So geht's").
 *
 *   Weitere Zahlung:  renderItemAnnounceCrewMail   — Person mit Soll
 *                     renderItemAnnouncePayeeMail  — vorstreckende Person: Übersicht
 *   Plan:             renderPlanAnnounceCrewMail   — Crew: Gesamtanteil + Raten
 *                     renderPlanAnnounceAdvancerMail — vorstreckende Person: Übersicht
 *
 * `isUpdate` = Variante für den Knopf „Crew informieren" (Betreff „Geändert: …",
 * sonst identischer Inhalt mit den AKTUELLEN Beträgen/Fristen).
 *
 * WERO-REGEL (Entscheidung Nutzer): Ist keine Wero-ID übergeben (null — der
 * Aufrufer normalisiert leer/Whitespace über normalizeWeroId), erwähnt die
 * Mail Wero mit keinem Wort. Der Verwendungszweck ist ein neutraler Vorschlag
 * für jede Überweisung und hängt nicht an Wero.
 *
 * ⚠️ Escaping: Bezeichnung, Kategorie, Törnname, Wero-ID und alle Namen sind
 * frei editierbar → im HTML IMMER escapeHtml. Text-Variante bleibt roh.
 */

import { escapeHtml, fmtEuro } from "./mail-shell";
import { tripVocab } from "@/lib/trip-vocab";
import { itemMailTitle, type ItemMailInfo } from "./item-notice-template";
import { round2 } from "@/lib/utils";
import {
  NO_DUE_TEXT,
  PAYMENT_STATUS,
  advanceSubject,
  howToBlock,
  howToPayBlock,
  personTable,
  renderPaymentMail,
  shareSubject,
  titledTableCard,
  tripPhrase,
  type Block,
  type Fact,
  type TripType,
} from "./payment-mail";

export interface PersonAmountRow {
  name: string;
  amount: number;
}

const PAID_DONE = "Dein Anteil ist bereits vollständig bezahlt — es ist nichts mehr zu tun.";
const pendingDone = (payee: string) =>
  `Deine Einzahlung ist gemeldet und wartet auf die Bestätigung durch ${payee} — von dir ist nichts mehr zu tun.`;

/** Zeile „Bis wann" der Anteil-Mail (Frist oder „Frist folgt"). */
const dueFact = (crewDue: string | null): Fact => ({
  label: "Bis wann",
  html: crewDue ? `<strong>${escapeHtml(crewDue)}</strong>` : escapeHtml(NO_DUE_TEXT),
  text: crewDue ?? NO_DUE_TEXT,
});

// ── Weitere Zahlung ────────────────────────────────────────────────────────

export interface ItemAnnounceCrewParams {
  isUpdate: boolean;
  recipientName: string;
  payeeName: string;
  tripName: string;
  tripType: TripType;
  item: ItemMailInfo;
  /** Soll der Person. */
  amount: number;
  /** Bereits BESTÄTIGT gezahlt (Update-Mail: nicht erneut zur Zahlung auffordern). */
  paid?: number;
  /** Gemeldet, aber noch nicht bestätigt (Selbstmeldung) — ebenfalls keine Aufforderung. */
  pending?: number;
  /** Formatierte Crewfrist (toCrewDueDate inkl. Puffer/Clamp) oder null = „Frist folgt". */
  crewDue: string | null;
  weroId: string | null;
  appUrl: string;
}

export function renderItemAnnounceCrewMail(p: ItemAnnounceCrewParams): { html: string; text: string; subject: string } {
  const title = itemMailTitle(p.item);
  const paid = Math.max(0, p.paid ?? 0);
  const pending = Math.max(0, p.pending ?? 0);
  const open = Math.max(0, round2(p.amount - paid - pending));
  const settled = open <= 0.005;
  const doneText = pending > 0.005 ? pendingDone(p.payeeName) : PAID_DONE;
  const subject = shareSubject({ what: p.item.label, amount: p.amount, due: p.crewDue, isUpdate: p.isUpdate });
  const headline = p.isUpdate ? `Geändert: ${p.item.label}` : `Neu: ${p.item.label}`;
  const introHtml = p.isUpdate
    ? `<strong>${escapeHtml(title)}</strong> für ${tripPhrase(p.tripType)} <strong>${escapeHtml(p.tripName)}</strong> hat sich geändert. Hier der aktuelle Stand für dich.`
    : `für ${tripPhrase(p.tripType)} <strong>${escapeHtml(p.tripName)}</strong> gibt es eine weitere Zahlung: <strong>${escapeHtml(title)}</strong>. ${escapeHtml(p.payeeName)} streckt vor und bekommt dafür deinen Anteil.`;
  const introText = p.isUpdate
    ? `${title} für ${tripPhrase(p.tripType)} ${p.tripName} hat sich geändert. Hier der aktuelle Stand für dich.`
    : `für ${tripPhrase(p.tripType)} ${p.tripName} gibt es eine weitere Zahlung: ${title}. ${p.payeeName} streckt vor und bekommt dafür deinen Anteil.`;

  const facts: Fact[] = [
    { label: "Dein Anteil", html: fmtEuro(p.amount), text: fmtEuro(p.amount), strong: true, color: "#114884" },
  ];
  if (paid > 0.005) facts.push({ label: "Bereits bezahlt", html: fmtEuro(paid), text: fmtEuro(paid) });
  if (pending > 0.005) {
    facts.push({
      label: "Gemeldet",
      html: `${fmtEuro(pending)} — ${escapeHtml(PAYMENT_STATUS.pending)}`,
      text: `${fmtEuro(pending)} — ${PAYMENT_STATUS.pending}`,
    });
  }
  if (paid > 0.005 || pending > 0.005) {
    facts.push({ label: "Noch offen", html: fmtEuro(open), text: fmtEuro(open), strong: true });
  }
  facts.push(settled ? { label: "Bis wann", html: escapeHtml(doneText), text: doneText } : dueFact(p.crewDue));
  facts.push({ label: "An wen", html: `<strong>${escapeHtml(p.payeeName)}</strong>`, text: p.payeeName });

  // „So geht's" nur, wenn noch etwas offen ist (Grill-Fund P2-1).
  const how: Block | null = settled
    ? null
    : howToPayBlock({ payeeName: p.payeeName, weroId: p.weroId, purpose: `${p.item.label} ${p.tripName}` });

  return renderPaymentMail({
    subject,
    headline,
    recipientName: p.recipientName,
    tripName: p.tripName,
    introHtml,
    introText,
    preheader: settled
      ? `${p.item.label}: dein Anteil ist bezahlt`
      : `${p.item.label}: offen ${fmtEuro(open)}${p.crewDue ? ` bis ${p.crewDue}` : ""}`,
    appUrl: p.appUrl,
    facts,
    how,
    hint: settled
      ? null
      : `Schon gezahlt? Dann tippe in der App bei „${p.item.label}“ auf „Ich habe gezahlt“, damit ${p.payeeName} die Einzahlung bestätigen kann.`,
  });
}

export interface ItemAnnouncePayeeParams {
  isUpdate: boolean;
  recipientName: string;
  tripName: string;
  tripType: TripType;
  item: ItemMailInfo;
  /** Betrag der weiteren Zahlung (= Summe an den Anbieter). */
  total: number;
  /** Formatierte Fälligkeit beim Anbieter oder null. */
  providerDue: string | null;
  /** Soll der übrigen Personen (ohne die vorstreckende Person selbst). */
  rows: PersonAmountRow[];
  /** Eigener Anteil der vorstreckenden Person (Selbstverrechnung). */
  ownAmount: number;
  appUrl: string;
}

export function renderItemAnnouncePayeeMail(p: ItemAnnouncePayeeParams): { html: string; text: string; subject: string } {
  const vocab = tripVocab(p.tripType);
  const title = itemMailTitle(p.item);
  const subject = advanceSubject({ what: p.item.label, amount: p.total, due: p.providerDue, isUpdate: p.isUpdate });
  const headline = p.isUpdate ? `Geändert: ${p.item.label}` : "Du streckst vor";
  const introHtml = `für ${tripPhrase(p.tripType)} <strong>${escapeHtml(p.tripName)}</strong> ${p.isUpdate ? "hat sich" : "gibt es"} <strong>${escapeHtml(title)}</strong> ${p.isUpdate ? "geändert" : "als weitere Zahlung"}. Du zahlst vorab an den Anbieter und bekommst die Anteile der ${escapeHtml(vocab.crew)}.`;
  const introText = `für ${tripPhrase(p.tripType)} ${p.tripName} ${p.isUpdate ? "hat sich" : "gibt es"} ${title} ${p.isUpdate ? "geändert" : "als weitere Zahlung"}. Du zahlst vorab an den Anbieter und bekommst die Anteile der ${vocab.crew}.`;
  const table = personTable(p.rows);
  const ownLine = p.ownAmount > 0.005 ? `Dein eigener Anteil: ${fmtEuro(p.ownAmount)} (Selbstverrechnung)` : "";

  const facts: Fact[] = [
    { label: "Du streckst vor", html: fmtEuro(p.total), text: fmtEuro(p.total), strong: true, color: "#114884" },
    {
      label: "Bis wann",
      html: p.providerDue ? `<strong>${escapeHtml(p.providerDue)}</strong>` : escapeHtml(NO_DUE_TEXT),
      text: p.providerDue ?? NO_DUE_TEXT,
    },
    { label: "An wen", html: "<strong>Anbieter</strong>", text: "Anbieter" },
  ];
  const extra: Block[] = [];
  if (p.rows.length > 0 || ownLine) {
    extra.push(titledTableCard("Soll je Person", table, ownLine || undefined));
  }

  return renderPaymentMail({
    subject,
    headline,
    recipientName: p.recipientName,
    tripName: p.tripName,
    introHtml,
    introText,
    preheader: `${p.item.label}: ${fmtEuro(p.total)} an den Anbieter${p.providerDue ? ` bis ${p.providerDue}` : ""}`,
    appUrl: p.appUrl,
    facts,
    extra,
    how: howToBlock(
      "Bestätige eingehende Einzahlungen in der App und erfasse deine Überweisung an den Anbieter bei der Karte unter „Überweisung an Anbieter erfassen“.",
    ),
  });
}

// ── Anzahlungsplan ─────────────────────────────────────────────────────────

export interface PlanCrewTranche {
  label: string;
  amount: number;
  /** Bereits BESTÄTIGT gezahlt für diese Rate (vom Aufrufer per allocateCoverage verteilt). */
  paid?: number;
  /** Gemeldet, wartet auf Bestätigung (ebenfalls per allocateCoverage verteilt). */
  pending?: number;
  /** Formatierte Crewfrist (3 Tage vor der Charterfrist, mit Clamp). */
  crewDue: string;
}

export interface PlanAnnounceCrewParams {
  isUpdate: boolean;
  recipientName: string;
  advancerName: string;
  tripName: string;
  tripType: TripType;
  total: number;
  tranches: PlanCrewTranche[];
  weroId: string | null;
  appUrl: string;
}

export function renderPlanAnnounceCrewMail(p: PlanAnnounceCrewParams): { html: string; text: string; subject: string } {
  const vocab = tripVocab(p.tripType);
  const rows = p.tranches.map((t) => {
    const paid = Math.max(0, t.paid ?? 0);
    const pending = Math.max(0, t.pending ?? 0);
    return { ...t, paid, pending, open: Math.max(0, round2(t.amount - paid - pending)) };
  });
  const totalOpen = round2(rows.reduce((s, t) => s + t.open, 0));
  const totalCovered = round2(rows.reduce((s, t) => s + t.paid + t.pending, 0));
  const totalPending = round2(rows.reduce((s, t) => s + t.pending, 0));
  const settled = totalOpen <= 0.005;
  const doneText = totalPending > 0.005 ? pendingDone(p.advancerName) : PAID_DONE;
  // Betreff-Frist: nächste noch offene Rate, sonst die letzte.
  const subjectDue = (rows.find((t) => t.open > 0.005) ?? rows[rows.length - 1])?.crewDue ?? null;
  const subject = shareSubject({ what: vocab.prepayment, amount: p.total, due: subjectDue, isUpdate: p.isUpdate });
  const headline = p.isUpdate ? `Geändert: ${vocab.prepayment}` : `${vocab.prepayment}: dein Anteil`;
  const introHtml = p.isUpdate
    ? `der Anzahlungsplan für ${tripPhrase(p.tripType)} <strong>${escapeHtml(p.tripName)}</strong> hat sich geändert. Hier deine aktuellen Raten.`
    : `für ${tripPhrase(p.tripType)} <strong>${escapeHtml(p.tripName)}</strong> streckt <strong>${escapeHtml(p.advancerName)}</strong> die ${escapeHtml(vocab.prepayment)} vor. Hier dein Anteil und wann du welche Rate zahlst.`;
  const introText = p.isUpdate
    ? `der Anzahlungsplan für ${tripPhrase(p.tripType)} ${p.tripName} hat sich geändert. Hier deine aktuellen Raten.`
    : `für ${tripPhrase(p.tripType)} ${p.tripName} streckt ${p.advancerName} die ${vocab.prepayment} vor. Hier dein Anteil und wann du welche Rate zahlst.`;
  const status = (t: (typeof rows)[number]) => {
    if (t.paid <= 0.005 && t.pending <= 0.005) return "";
    if (t.open <= 0.005) return t.pending > 0.005 ? ` (${PAYMENT_STATUS.pending})` : " (bezahlt)";
    const parts = [
      t.paid > 0.005 ? `bezahlt ${fmtEuro(t.paid)}` : "",
      t.pending > 0.005 ? `gemeldet ${fmtEuro(t.pending)}` : "",
      `offen ${fmtEuro(t.open)}`,
    ].filter(Boolean);
    return ` (${parts.join(", ")})`;
  };
  const rateHtml = rows
    .map(
      (t) =>
        `<strong>${escapeHtml(t.label)}</strong> bis ${escapeHtml(t.crewDue)}: ${fmtEuro(t.amount)}<span style="color:#587EA8;">${escapeHtml(status(t))}</span>`,
    )
    .join("<br/>");
  const rateText = rows.map((t) => `  - ${t.label} bis ${t.crewDue}: ${fmtEuro(t.amount)}${status(t)}`).join("\n");

  const facts: Fact[] = [
    { label: "Dein Anteil", html: `${fmtEuro(p.total)} gesamt`, text: `${fmtEuro(p.total)} gesamt`, strong: true, color: "#114884" },
  ];
  if (totalCovered > 0.005) facts.push({ label: "Noch offen", html: fmtEuro(totalOpen), text: fmtEuro(totalOpen), strong: true });
  facts.push(
    settled
      ? { label: "Bis wann", html: escapeHtml(doneText), text: doneText }
      : { label: "Bis wann", html: rateHtml, text: rateText },
  );
  facts.push({ label: "An wen", html: `<strong>${escapeHtml(p.advancerName)}</strong>`, text: p.advancerName });

  // „So geht's" nur, wenn noch etwas offen ist (Grill-Fund P2-1).
  const how: Block | null = settled
    ? null
    : howToPayBlock({ payeeName: p.advancerName, weroId: p.weroId, purpose: `Anzahlung ${p.tripName}` });

  return renderPaymentMail({
    subject,
    headline,
    recipientName: p.recipientName,
    tripName: p.tripName,
    introHtml,
    introText,
    preheader: settled
      ? "Dein Anteil ist bezahlt"
      : `Offen: ${fmtEuro(totalOpen)} in ${rows.length} ${rows.length === 1 ? "Rate" : "Raten"}`,
    appUrl: p.appUrl,
    facts,
    how,
    hint: settled
      ? null
      : `Schon gezahlt? Dann tippe in der App bei der Rate auf „Ich habe gezahlt“, damit ${p.advancerName} die Einzahlung bestätigen kann.`,
  });
}

export interface PlanAdvancerTranche {
  label: string;
  /** Formatierte Charterfrist (echtes Datum gegenüber dem Anbieter). */
  charterDue: string;
  /** Rate an den Anbieter (Plansumme × %). */
  toProvider: number;
  /** Σ Crew-Soll dieser Rate (ohne den eigenen Anteil). */
  fromCrew: number;
}

export interface PlanAnnounceAdvancerParams {
  isUpdate: boolean;
  recipientName: string;
  tripName: string;
  tripType: TripType;
  providerTotal: number;
  tranches: PlanAdvancerTranche[];
  rows: PersonAmountRow[];
  ownAmount: number;
  appUrl: string;
}

export function renderPlanAnnounceAdvancerMail(p: PlanAnnounceAdvancerParams): { html: string; text: string; subject: string } {
  const vocab = tripVocab(p.tripType);
  const subjectDue = p.tranches[0]?.charterDue ?? null;
  const subject = advanceSubject({ what: vocab.prepayment, amount: p.providerTotal, due: subjectDue, isUpdate: p.isUpdate });
  const headline = p.isUpdate ? `Geändert: ${vocab.prepayment}` : "Du streckst vor";
  const introHtml = `für ${tripPhrase(p.tripType)} <strong>${escapeHtml(p.tripName)}</strong> streckst du die ${escapeHtml(vocab.prepayment)} vor. ${p.isUpdate ? "Der Plan hat sich geändert — hier" : "Hier"} die Übersicht: was du an den Anbieter zahlst und was die ${escapeHtml(vocab.crew)} dir überweist.`;
  const introText = `für ${tripPhrase(p.tripType)} ${p.tripName} streckst du die ${vocab.prepayment} vor. ${p.isUpdate ? "Der Plan hat sich geändert — hier" : "Hier"} die Übersicht: was du an den Anbieter zahlst und was die ${vocab.crew} dir überweist.`;
  const rateHtml = p.tranches
    .map(
      (t) =>
        `<strong>${escapeHtml(t.label)}</strong> bis ${escapeHtml(t.charterDue)}: ${fmtEuro(t.toProvider)}<br/><span style="color:#587EA8;font-size:12px;">davon von der ${escapeHtml(vocab.crew)}: ${fmtEuro(t.fromCrew)}</span>`,
    )
    .join("<br/>");
  const rateText = p.tranches
    .map((t) => `  - ${t.label} bis ${t.charterDue}: ${fmtEuro(t.toProvider)} an den Anbieter, davon ${fmtEuro(t.fromCrew)} von der ${vocab.crew}`)
    .join("\n");
  const table = personTable(p.rows);
  const ownLine = p.ownAmount > 0.005 ? `Dein eigener Anteil: ${fmtEuro(p.ownAmount)} (Selbstverrechnung)` : "";

  const facts: Fact[] = [
    { label: "Du streckst vor", html: fmtEuro(p.providerTotal), text: fmtEuro(p.providerTotal), strong: true, color: "#114884" },
    { label: "Bis wann", html: rateHtml, text: rateText },
    { label: "An wen", html: "<strong>Anbieter</strong>", text: "Anbieter" },
  ];
  const extra: Block[] = [];
  if (p.rows.length > 0 || ownLine) extra.push(titledTableCard("Soll je Person", table, ownLine || undefined));

  return renderPaymentMail({
    subject,
    headline,
    recipientName: p.recipientName,
    tripName: p.tripName,
    introHtml,
    introText,
    preheader: `${fmtEuro(p.providerTotal)} an den Anbieter in ${p.tranches.length} ${p.tranches.length === 1 ? "Rate" : "Raten"}`,
    appUrl: p.appUrl,
    facts,
    extra,
    how: howToBlock(
      `Die ${vocab.crew} soll jeweils 3 Tage vor der Fälligkeit zahlen, damit du das Geld rechtzeitig zusammen hast. Bestätige eingehende Einzahlungen in der App.`,
    ),
  });
}
