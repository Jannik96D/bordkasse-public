/**
 * „Neu angelegt"- und „hat sich geändert"-Mails für Reise-Posten und den
 * Anzahlungsplan (PR6). Layout über mail-shell wie alle anderen Mails.
 *
 *   Posten:  renderItemAnnounceCrewMail   — Person mit Soll: wofür, wie viel,
 *                                           bis wann (Crewfrist), an wen
 *            renderItemAnnouncePayeeMail  — Empfänger: Übersicht + Frist beim
 *                                           Anbieter
 *   Plan:    renderPlanAnnounceCrewMail   — Crew: eigener Gesamtbetrag, jede
 *                                           Rate mit Betrag + Crewfrist
 *            renderPlanAnnounceAdvancerMail — vorstreckende Person: Übersicht
 *
 * `isUpdate` = Variante für den Knopf „Crew informieren" (Wortlaut „hat sich
 * geändert", sonst identischer Inhalt mit den AKTUELLEN Beträgen/Fristen).
 *
 * WERO-REGEL (Entscheidung Nutzer): Ist keine Wero-ID übergeben (null — der
 * Aufrufer normalisiert leer/Whitespace über normalizeWeroId), erwähnt die
 * Mail Wero mit keinem Wort. Der Verwendungszweck ist ein neutraler Vorschlag
 * für jede Überweisung und hängt nicht an Wero.
 *
 * ⚠️ Escaping: Bezeichnung, Kategorie, Törnname, Wero-ID und alle Namen sind
 * frei editierbar → im HTML IMMER escapeHtml. Text-Variante bleibt roh.
 */

import { renderMailShell, renderActionButton, renderHintBlock, escapeHtml, fmtEuro } from "./mail-shell";
import { tripVocab } from "@/lib/trip-vocab";
import { itemMailTitle, type ItemMailInfo } from "./item-notice-template";
import { normalizeWeroId } from "@/lib/prepayments/notify";
import { round2 } from "@/lib/utils";

type TripType = "sailing" | "other";
const FOOTER = "—\nBordkasse · Faire Kostenaufteilung auf Segeltörns\n";
const tripPhrase = (t: TripType) => (t === "other" ? "die Reise" : "den Törn");
const NO_DUE_TEXT = "Eine Frist ist noch nicht festgelegt — sie folgt.";

export interface PersonAmountRow {
  name: string;
  amount: number;
}

// ── Bausteine ─────────────────────────────────────────────────────────────

/** „So zahlst du": Empfänger, Wero (nur mit ID), neutraler Verwendungszweck. */
function paymentBlock(args: { payeeName: string; weroId: string | null; purpose: string }): { html: string; text: string } {
  const n = escapeHtml(args.payeeName);
  // Defensiv nochmals normalisieren: leer/Whitespace = keine Wero-ID.
  const weroId = normalizeWeroId(args.weroId);
  if (weroId) {
    return {
      html: `
            <tr>
              <td style="padding:16px 32px 0 32px;">
                <p style="margin:0 0 8px 0;font-size:14px;line-height:1.55;color:#1A2533;">
                  Bitte schicke <strong>${n}</strong> deinen Anteil per Wero.
                </p>
                <p style="margin:0;padding:10px 14px;background-color:#FDF6DC;border-left:3px solid #C8A51E;font-size:13px;color:#1A2533;border-radius:4px;">
                  <strong>Wero-ID (${n}):</strong> ${escapeHtml(weroId)}<br/>
                  <span style="color:#587EA8;">Verwendungszweck: ${escapeHtml(args.purpose)}</span>
                </p>
              </td>
            </tr>`,
      text: `Bitte schicke ${args.payeeName} deinen Anteil per Wero.
Wero-ID (${args.payeeName}): ${weroId}
Verwendungszweck: ${args.purpose}`,
    };
  }
  return {
    html: `
            <tr>
              <td style="padding:16px 32px 0 32px;">
                <p style="margin:0;padding:10px 14px;background-color:#FDF6DC;border-left:3px solid #C8A51E;font-size:13px;color:#1A2533;border-radius:4px;">
                  Bitte überweise deinen Anteil an <strong>${n}</strong> — frag ${n} nach den Zahlungsdetails.<br/>
                  <span style="color:#587EA8;">Verwendungszweck: ${escapeHtml(args.purpose)}</span>
                </p>
              </td>
            </tr>`,
    text: `Bitte überweise deinen Anteil an ${args.payeeName} — frag ${args.payeeName} nach den Zahlungsdetails.
Verwendungszweck: ${args.purpose}`,
  };
}

function headerBlock(headline: string, recipientName: string, introHtml: string): string {
  return `
            <tr>
              <td style="padding:32px 32px 8px 32px;">
                <h2 style="margin:0 0 12px 0;font-size:18px;font-weight:600;color:#1D4281;">
                  ${escapeHtml(headline)}
                </h2>
                <p style="margin:0 0 12px 0;font-size:15px;line-height:1.55;color:#1A2533;">
                  Hi ${escapeHtml(recipientName)},
                </p>
                <p style="margin:0;font-size:15px;line-height:1.55;color:#1A2533;">
                  ${introHtml}
                </p>
              </td>
            </tr>`;
}

function personTable(rows: PersonAmountRow[]): { html: string; text: string } {
  const html = rows
    .map(
      (r) => `
                        <tr>
                          <td style="padding:2px 0;color:#1A2533;">${escapeHtml(r.name)}</td>
                          <td style="padding:2px 0;text-align:right;">${fmtEuro(r.amount)}</td>
                        </tr>`,
    )
    .join("");
  const text = rows.map((r) => `  - ${r.name}: ${fmtEuro(r.amount)}`).join("\n");
  return { html, text };
}

function card(inner: string): string {
  return `
            <tr>
              <td style="padding:18px 32px 0 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding:14px;background-color:#F4F2EC;border-radius:6px;font-size:14px;color:#1A2533;">
                      ${inner}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`;
}

// ── Posten ────────────────────────────────────────────────────────────────

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
  /** Formatierte Crewfrist (toCrewDueDate inkl. Puffer/Clamp) oder null = „Frist folgt". */
  crewDue: string | null;
  weroId: string | null;
  appUrl: string;
}

const PAID_DONE = "Dein Anteil ist bereits vollständig bezahlt — es ist nichts mehr zu tun.";

export function renderItemAnnounceCrewMail(p: ItemAnnounceCrewParams): { html: string; text: string; subject: string } {
  const vocab = tripVocab(p.tripType);
  const title = itemMailTitle(p.item);
  const paid = Math.max(0, p.paid ?? 0);
  const open = Math.max(0, round2(p.amount - paid));
  const settled = open <= 0.005;
  const subject = p.isUpdate
    ? `Posten geändert: ${p.item.label} – ${p.tripName}`
    : `Neuer Posten: ${p.item.label} – ${p.tripName}`;
  const headline = p.isUpdate ? "Posten hat sich geändert" : "Neuer Posten";
  const lead = p.isUpdate
    ? `der Posten <strong>${escapeHtml(title)}</strong> für ${tripPhrase(p.tripType)} <strong>${escapeHtml(p.tripName)}</strong> hat sich geändert. Hier der aktuelle Stand für dich.`
    : `für ${tripPhrase(p.tripType)} <strong>${escapeHtml(p.tripName)}</strong> gibt es einen neuen Posten: <strong>${escapeHtml(title)}</strong>. ${escapeHtml(p.payeeName)} zahlt vorab an den Anbieter und bekommt dafür deinen Anteil.`;
  const leadText = p.isUpdate
    ? `der Posten ${title} für ${tripPhrase(p.tripType)} ${p.tripName} hat sich geändert. Hier der aktuelle Stand für dich.`
    : `für ${tripPhrase(p.tripType)} ${p.tripName} gibt es einen neuen Posten: ${title}. ${p.payeeName} zahlt vorab an den Anbieter und bekommt dafür deinen Anteil.`;
  const dueHtml = settled
    ? escapeHtml(PAID_DONE)
    : p.crewDue
      ? `bitte zahlen bis <strong>${escapeHtml(p.crewDue)}</strong>`
      : escapeHtml(NO_DUE_TEXT);
  const dueText = settled ? PAID_DONE : p.crewDue ? `Bitte zahlen bis: ${p.crewDue}` : NO_DUE_TEXT;
  const purpose = `${p.item.label} ${p.tripName}`;
  // Zahlungsaufforderung nur, wenn noch etwas offen ist (Grill-Fund P2-1).
  const pay = settled ? { html: "", text: "" } : paymentBlock({ payeeName: p.payeeName, weroId: p.weroId, purpose });
  const paidHtml =
    paid > 0.005
      ? `Bereits bezahlt: ${fmtEuro(paid)}<br/>
                      Noch offen: <strong>${fmtEuro(open)}</strong><br/>`
      : "";
  const paidText = paid > 0.005 ? `\n  Bereits bezahlt: ${fmtEuro(paid)}\n  Noch offen:  ${fmtEuro(open)}` : "";
  const hint = `Schon gezahlt? Dann tippe in der App beim Posten auf „Ich habe gezahlt“, damit ${p.payeeName} die Zahlung bestätigen kann.`;

  const body = `${headerBlock(headline, p.recipientName, lead)}
${card(`<strong>${escapeHtml(title)}</strong><br/>
                      Dein Anteil: <strong style="color:#114884;">${fmtEuro(p.amount)}</strong><br/>
                      ${paidHtml}An: <strong>${escapeHtml(p.payeeName)}</strong><br/>
                      <span style="color:#587EA8;">${dueHtml}</span>`)}
${pay.html}
${renderActionButton(p.appUrl, `In der ${vocab.kitty} ansehen`)}
${settled ? "" : renderHintBlock(hint)}`;

  const html = renderMailShell({
    title: subject,
    preheader: settled
      ? `${p.item.label}: dein Anteil ist bezahlt`
      : `${p.item.label}: offen ${fmtEuro(open)}${p.crewDue ? ` bis ${p.crewDue}` : ""}`,
    subtitle: p.tripName,
    body,
  });

  const text = `${headline}
${p.tripName}

Hi ${p.recipientName},

${leadText}

  Posten:      ${title}
  Dein Anteil: ${fmtEuro(p.amount)}${paidText}
  An:          ${p.payeeName}
  ${dueText}
${pay.text ? `\n${pay.text}\n` : ""}${settled ? "" : `\n${hint}\n`}
In der App: ${p.appUrl}

${FOOTER}`;

  return { html, text, subject };
}

export interface ItemAnnouncePayeeParams {
  isUpdate: boolean;
  recipientName: string;
  tripName: string;
  tripType: TripType;
  item: ItemMailInfo;
  /** Betrag des Postens (= Summe an den Anbieter). */
  total: number;
  /** Formatierte Fälligkeit beim Anbieter oder null. */
  providerDue: string | null;
  /** Soll der übrigen Personen (ohne den Empfänger selbst). */
  rows: PersonAmountRow[];
  /** Eigener Anteil des Empfängers (Selbstverrechnung). */
  ownAmount: number;
  appUrl: string;
}

export function renderItemAnnouncePayeeMail(p: ItemAnnouncePayeeParams): { html: string; text: string; subject: string } {
  const vocab = tripVocab(p.tripType);
  const title = itemMailTitle(p.item);
  const subject = p.isUpdate
    ? `Posten geändert: ${p.item.label} – Übersicht für dich`
    : `Neuer Posten: ${p.item.label} – Übersicht für dich`;
  const headline = p.isUpdate ? "Dein Posten hat sich geändert" : "Du empfängst einen Posten";
  const lead = `für ${tripPhrase(p.tripType)} <strong>${escapeHtml(p.tripName)}</strong> ${p.isUpdate ? "hat sich der Posten" : "ist der Posten"} <strong>${escapeHtml(title)}</strong> ${p.isUpdate ? "geändert" : "angelegt"}. Du zahlst an den Anbieter und bekommst die Anteile der ${escapeHtml(vocab.crew)}.`;
  const leadText = `für ${tripPhrase(p.tripType)} ${p.tripName} ${p.isUpdate ? "hat sich der Posten" : "ist der Posten"} ${title} ${p.isUpdate ? "geändert" : "angelegt"}. Du zahlst an den Anbieter und bekommst die Anteile der ${vocab.crew}.`;
  const dueHtml = p.providerDue
    ? `An den Anbieter zu zahlen bis <strong>${escapeHtml(p.providerDue)}</strong>`
    : escapeHtml(NO_DUE_TEXT);
  const dueText = p.providerDue ? `An den Anbieter zu zahlen bis: ${p.providerDue}` : NO_DUE_TEXT;
  const table = personTable(p.rows);
  const ownLine = p.ownAmount > 0.005 ? `Dein eigener Anteil: ${fmtEuro(p.ownAmount)} (Selbstverrechnung)` : "";

  const body = `${headerBlock(headline, p.recipientName, lead)}
${card(`<strong>${escapeHtml(title)}</strong> · Summe Anbieter: <strong>${fmtEuro(p.total)}</strong><br/>
                      <span style="color:#587EA8;">${dueHtml}</span>
                      ${
                        p.rows.length > 0
                          ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;font-size:13px;">${table.html}
                      </table>`
                          : ""
                      }
                      ${ownLine ? `<p style="margin:8px 0 0 0;font-size:13px;color:#587EA8;">${escapeHtml(ownLine)}</p>` : ""}`)}
${renderActionButton(p.appUrl, `In der ${vocab.kitty} ansehen`)}
${renderHintBlock(
  "Bestätige eingehende Zahlungen in der App und erfasse deine Zahlung an den Anbieter beim Posten unter „Zahlung an Anbieter erfassen“.",
)}`;

  const html = renderMailShell({
    title: subject,
    preheader: `${p.item.label}: ${fmtEuro(p.total)} an den Anbieter${p.providerDue ? ` bis ${p.providerDue}` : ""}`,
    subtitle: p.tripName,
    body,
  });

  const text = `${headline}
${p.tripName}

Hi ${p.recipientName},

${leadText}

  Posten:          ${title}
  Summe Anbieter:  ${fmtEuro(p.total)}
  ${dueText}
${p.rows.length > 0 ? `\nSoll je Person:\n${table.text}\n` : ""}${ownLine ? `\n${ownLine}\n` : ""}
Bestätige eingehende Zahlungen in der App und erfasse deine Zahlung an den Anbieter beim Posten unter „Zahlung an Anbieter erfassen“.

In der App: ${p.appUrl}

${FOOTER}`;

  return { html, text, subject };
}

// ── Anzahlungsplan ────────────────────────────────────────────────────────

export interface PlanCrewTranche {
  label: string;
  amount: number;
  /** Bereits BESTÄTIGT gezahlt für diese Rate. */
  paid?: number;
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
    return { ...t, paid, open: Math.max(0, round2(t.amount - paid)) };
  });
  const totalOpen = round2(rows.reduce((s, t) => s + t.open, 0));
  const totalPaid = round2(rows.reduce((s, t) => s + t.paid, 0));
  const settled = totalOpen <= 0.005;
  const subject = p.isUpdate
    ? `${vocab.prepayment}: Plan geändert – ${p.tripName}`
    : `${vocab.prepayment}: dein Anteil für ${p.tripName}`;
  const headline = p.isUpdate ? "Anzahlungsplan hat sich geändert" : "Anzahlungsplan steht";
  const lead = p.isUpdate
    ? `der Anzahlungsplan für ${tripPhrase(p.tripType)} <strong>${escapeHtml(p.tripName)}</strong> hat sich geändert. Hier deine aktuellen Raten.`
    : `für ${tripPhrase(p.tripType)} <strong>${escapeHtml(p.tripName)}</strong> streckt <strong>${escapeHtml(p.advancerName)}</strong> die ${escapeHtml(vocab.prepayment)} vor. Hier dein Anteil und wann du welche Rate zahlst.`;
  const leadText = p.isUpdate
    ? `der Anzahlungsplan für ${tripPhrase(p.tripType)} ${p.tripName} hat sich geändert. Hier deine aktuellen Raten.`
    : `für ${tripPhrase(p.tripType)} ${p.tripName} streckt ${p.advancerName} die ${vocab.prepayment} vor. Hier dein Anteil und wann du welche Rate zahlst.`;
  const status = (t: (typeof rows)[number]) =>
    t.paid <= 0.005 ? "" : t.open <= 0.005 ? " (bezahlt)" : ` (bezahlt ${fmtEuro(t.paid)}, offen ${fmtEuro(t.open)})`;
  const rowsHtml = rows
    .map(
      (t) => `
                        <tr>
                          <td style="padding:3px 0;color:#1A2533;"><strong>${escapeHtml(t.label)}</strong> <span style="color:#587EA8;">bis ${escapeHtml(t.crewDue)}${escapeHtml(status(t))}</span></td>
                          <td style="padding:3px 0;text-align:right;">${fmtEuro(t.amount)}</td>
                        </tr>`,
    )
    .join("");
  const rowsText = rows.map((t) => `  - ${t.label} bis ${t.crewDue}: ${fmtEuro(t.amount)}${status(t)}`).join("\n");
  // Zahlungsaufforderung nur, wenn noch etwas offen ist (Grill-Fund P2-1).
  const pay = settled
    ? { html: "", text: "" }
    : paymentBlock({ payeeName: p.advancerName, weroId: p.weroId, purpose: `Anzahlung ${p.tripName}` });
  const summaryHtml = settled
    ? `<p style="margin:8px 0 0 0;font-size:13px;color:#1E8449;">${escapeHtml(PAID_DONE)}</p>`
    : totalPaid > 0.005
      ? `<p style="margin:8px 0 0 0;font-size:13px;color:#1A2533;">Noch offen: <strong>${fmtEuro(totalOpen)}</strong></p>`
      : "";
  const summaryText = settled ? `\n${PAID_DONE}` : totalPaid > 0.005 ? `\nNoch offen: ${fmtEuro(totalOpen)}` : "";
  const hint = `Schon gezahlt? Dann tippe in der App bei der Rate auf „Ich habe gezahlt“, damit ${p.advancerName} die Zahlung bestätigen kann.`;

  const body = `${headerBlock(headline, p.recipientName, lead)}
${card(`Dein Anteil gesamt: <strong style="color:#114884;">${fmtEuro(p.total)}</strong> · an <strong>${escapeHtml(p.advancerName)}</strong>
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;font-size:13px;">${rowsHtml}
                      </table>${summaryHtml}`)}
${pay.html}
${renderActionButton(p.appUrl, `In der ${vocab.kitty} ansehen`)}
${settled ? "" : renderHintBlock(hint)}`;

  const html = renderMailShell({
    title: subject,
    preheader: settled
      ? "Dein Anteil ist bezahlt"
      : `Offen: ${fmtEuro(totalOpen)} in ${rows.length} ${rows.length === 1 ? "Rate" : "Raten"}`,
    subtitle: p.tripName,
    body,
  });

  const text = `${headline}
${p.tripName}

Hi ${p.recipientName},

${leadText}

Dein Anteil gesamt: ${fmtEuro(p.total)} (an ${p.advancerName})
${rowsText}${summaryText}
${pay.text ? `\n${pay.text}\n` : ""}${settled ? "" : `\n${hint}\n`}
In der App: ${p.appUrl}

${FOOTER}`;

  return { html, text, subject };
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
  const subject = p.isUpdate
    ? `${vocab.prepayment}: Plan geändert – Übersicht für dich`
    : `${vocab.prepayment}: Übersicht für dich – ${p.tripName}`;
  const headline = p.isUpdate ? "Anzahlungsplan hat sich geändert" : "Du streckst vor";
  const lead = `für ${tripPhrase(p.tripType)} <strong>${escapeHtml(p.tripName)}</strong> streckst du die ${escapeHtml(vocab.prepayment)} vor. ${p.isUpdate ? "Der Plan hat sich geändert — hier" : "Hier"} die Übersicht: was du an den ${escapeHtml(vocab.provider)} zahlst und was die ${escapeHtml(vocab.crew)} dir überweist.`;
  const leadText = `für ${tripPhrase(p.tripType)} ${p.tripName} streckst du die ${vocab.prepayment} vor. ${p.isUpdate ? "Der Plan hat sich geändert — hier" : "Hier"} die Übersicht: was du an den ${vocab.provider} zahlst und was die ${vocab.crew} dir überweist.`;
  const trHtml = p.tranches
    .map(
      (t) => `
                        <tr>
                          <td style="padding:3px 0;color:#1A2533;"><strong>${escapeHtml(t.label)}</strong> <span style="color:#587EA8;">fällig ${escapeHtml(t.charterDue)}</span></td>
                          <td style="padding:3px 0;text-align:right;">${fmtEuro(t.toProvider)}</td>
                        </tr>
                        <tr>
                          <td style="padding:0 0 4px 0;color:#587EA8;font-size:12px;">davon von der ${escapeHtml(vocab.crew)}</td>
                          <td style="padding:0 0 4px 0;text-align:right;color:#587EA8;font-size:12px;">${fmtEuro(t.fromCrew)}</td>
                        </tr>`,
    )
    .join("");
  const trText = p.tranches
    .map((t) => `  - ${t.label} (fällig ${t.charterDue}): ${fmtEuro(t.toProvider)} an den ${vocab.provider}, davon ${fmtEuro(t.fromCrew)} von der ${vocab.crew}`)
    .join("\n");
  const table = personTable(p.rows);
  const ownLine = p.ownAmount > 0.005 ? `Dein eigener Anteil: ${fmtEuro(p.ownAmount)} (Selbstverrechnung)` : "";

  const body = `${headerBlock(headline, p.recipientName, lead)}
${card(`Summe an den ${escapeHtml(vocab.provider)}: <strong>${fmtEuro(p.providerTotal)}</strong>
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;font-size:13px;">${trHtml}
                      </table>`)}
${
  p.rows.length > 0 || ownLine
    ? card(`<strong>Soll je Person</strong>
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:6px;font-size:13px;">${table.html}
                      </table>
                      ${ownLine ? `<p style="margin:8px 0 0 0;font-size:13px;color:#587EA8;">${escapeHtml(ownLine)}</p>` : ""}`)
    : ""
}
${renderActionButton(p.appUrl, `In der ${vocab.kitty} ansehen`)}
${renderHintBlock(
  `Die ${vocab.crew} soll jeweils 3 Tage vor der Fälligkeit zahlen, damit du das Geld rechtzeitig zusammen hast. Bestätige eingehende Zahlungen in der App.`,
)}`;

  const html = renderMailShell({
    title: subject,
    preheader: `${fmtEuro(p.providerTotal)} an den ${vocab.provider} in ${p.tranches.length} ${p.tranches.length === 1 ? "Rate" : "Raten"}`,
    subtitle: p.tripName,
    body,
  });

  const text = `${headline}
${p.tripName}

Hi ${p.recipientName},

${leadText}

Summe an den ${vocab.provider}: ${fmtEuro(p.providerTotal)}
${trText}
${p.rows.length > 0 ? `\nSoll je Person:\n${table.text}\n` : ""}${ownLine ? `\n${ownLine}\n` : ""}
Die ${vocab.crew} soll jeweils 3 Tage vor der Fälligkeit zahlen, damit du das Geld rechtzeitig zusammen hast. Bestätige eingehende Zahlungen in der App.

In der App: ${p.appUrl}

${FOOTER}`;

  return { html, text, subject };
}
