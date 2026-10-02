/**
 * Mail-Templates für die automatischen Posten-Erinnerungen (PR5, Migration
 * 0061) — Layout über `mail-shell.ts` wie alle anderen Mails.
 *
 *   • renderItemCrewReminderMail  (item_crew_3d)  — Crew-Person, offener Anteil
 *   • renderItemPayeeReminderMail (item_payee_3d) — Empfänger, Übersicht
 *     Anbieter-Soll / Crew-Eingänge / bereits überwiesen / noch offen
 *
 * ⚠️ Escaping: Posten-Bezeichnung, Kategorie, Törnname und alle Namen sind
 * frei editierbarer Text → im HTML IMMER durch `escapeHtml` (Lehre aus
 * prepayment-notice-template, Fund 1 PR 6). Die Text-Variante bleibt roh.
 */

import { renderMailShell, renderActionButton, renderHintBlock, escapeHtml, fmtEuro } from "./mail-shell";
import { tripVocab } from "@/lib/trip-vocab";

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
const tripPhrase = (t: "sailing" | "other") => (t === "other" ? "die Reise" : "den Törn");
const FOOTER = "—\nBordkasse · Faire Kostenaufteilung auf Segeltörns\n";

export function renderItemCrewReminderMail(p: ItemCrewReminderParams): { html: string; text: string; subject: string } {
  const vocab = tripVocab(p.tripType);
  const title = itemTitle(p.item);
  const subject = `Erinnerung: ${p.item.label} für ${p.tripName}`;
  const partly = Math.abs(p.amountSoll - p.amountOpen) > 0.005;

  const body = `
            <tr>
              <td style="padding:32px 32px 8px 32px;">
                <h2 style="margin:0 0 12px 0;font-size:18px;font-weight:600;color:#1D4281;">
                  Erinnerung: ${escapeHtml(p.item.label)}
                </h2>
                <p style="margin:0 0 12px 0;font-size:15px;line-height:1.55;color:#1A2533;">
                  Hi ${escapeHtml(p.recipientName)},
                </p>
                <p style="margin:0;font-size:15px;line-height:1.55;color:#1A2533;">
                  für ${tripPhrase(p.tripType)} <strong>${escapeHtml(p.tripName)}</strong> ist dein Anteil am Posten
                  <strong>${escapeHtml(title)}</strong> noch offen. Bitte überweise ihn bis
                  <strong>${escapeHtml(p.crewDueDate)}</strong> an <strong>${escapeHtml(p.payeeName)}</strong>.
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:18px 32px 0 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding:10px 14px;background-color:#F4F2EC;border-radius:6px;font-size:14px;color:#1A2533;">
                      <strong>${escapeHtml(title)}</strong> &nbsp;
                      <span style="color:#587EA8;">bitte zahlen bis ${escapeHtml(p.crewDueDate)}</span><br/>
                      Offen: <strong>${fmtEuro(p.amountOpen)}</strong>${partly ? ` (von ${fmtEuro(p.amountSoll)})` : ""}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
${renderActionButton(p.appUrl, `In der ${vocab.kitty} anzeigen`)}
${renderHintBlock(
  `Schon gezahlt? Dann tippe in der App beim Posten auf „Ich habe gezahlt“, damit ${p.payeeName} die Zahlung bestätigen kann.`,
)}`;

  const html = renderMailShell({
    title: subject,
    preheader: `Offen: ${fmtEuro(p.amountOpen)} für ${p.item.label} — bis ${p.crewDueDate}`,
    subtitle: p.tripName,
    body,
  });

  const text = `Erinnerung: ${p.item.label}
${p.tripName}

Hi ${p.recipientName},

für ${tripPhrase(p.tripType)} ${p.tripName} ist dein Anteil am Posten ${title} noch offen.
Bitte überweise ihn bis ${p.crewDueDate} an ${p.payeeName}.

Offen: ${fmtEuro(p.amountOpen)}${partly ? ` (von ${fmtEuro(p.amountSoll)})` : ""}

Schon gezahlt? Dann tippe in der App beim Posten auf „Ich habe gezahlt“, damit ${p.payeeName} die Zahlung bestätigen kann.

In der App: ${p.appUrl}

${FOOTER}`;

  return { html, text, subject };
}

export function renderItemPayeeReminderMail(p: ItemPayeeReminderParams): { html: string; text: string; subject: string } {
  const vocab = tripVocab(p.tripType);
  const title = itemTitle(p.item);
  const subject = `${p.item.label}: Zahlung an den Anbieter steht an – ${p.tripName}`;

  const row = (label: string, value: string, strong = false) => `
                      <tr>
                        <td style="padding:2px 0;color:${strong ? "#1A2533;font-weight:600" : "#587EA8"};">${escapeHtml(label)}</td>
                        <td style="padding:2px 0;text-align:right;${strong ? "font-weight:700;color:#A93226;" : ""}">${value}</td>
                      </tr>`;

  const ownBlock =
    p.ownOpen > 0.005
      ? `
            <tr>
              <td style="padding:12px 32px 0 32px;">
                <p style="margin:0;padding:10px 14px;background-color:#FDF6DC;border-left:3px solid #C8A51E;font-size:13px;color:#1A2533;border-radius:4px;">
                  Dein eigener Anteil (${fmtEuro(p.ownOpen)}) ist noch nicht als Selbstverrechnung erfasst. Trag ihn in der App beim Posten ein, damit der Posten abgeschlossen werden kann.
                </p>
              </td>
            </tr>`
      : "";

  const body = `
            <tr>
              <td style="padding:32px 32px 8px 32px;">
                <h2 style="margin:0 0 12px 0;font-size:18px;font-weight:600;color:#1D4281;">
                  Zahlung an den Anbieter steht an
                </h2>
                <p style="margin:0 0 12px 0;font-size:15px;line-height:1.55;color:#1A2533;">
                  Hi ${escapeHtml(p.recipientName)},
                </p>
                <p style="margin:0;font-size:15px;line-height:1.55;color:#1A2533;">
                  am <strong>${escapeHtml(p.providerDueDate)}</strong> ist der Posten <strong>${escapeHtml(title)}</strong>
                  für ${tripPhrase(p.tripType)} <strong>${escapeHtml(p.tripName)}</strong> beim Anbieter fällig.
                  Hier der aktuelle Stand.
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:18px 32px 0 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding:14px;background-color:#F4F2EC;border-radius:6px;font-size:14px;color:#1A2533;">
                      <div style="margin-bottom:4px;">
                        <strong>${escapeHtml(title)}</strong>
                        <span style="color:#587EA8;"> · fällig ${escapeHtml(p.providerDueDate)}</span>
                      </div>
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:6px;font-size:13px;">
                        ${row("Soll Anbieter:", fmtEuro(p.providerSoll))}
                        ${row(`${vocab.crew} bei dir eingegangen:`, `${fmtEuro(p.crewPaid)} <span style="color:#587EA8;">von ${fmtEuro(p.crewSoll)}</span>`)}
                        ${row("An den Anbieter überwiesen:", fmtEuro(p.providerPaid))}
                        ${row("Noch zu überweisen:", fmtEuro(p.providerOpen), true)}
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
${ownBlock}
${renderActionButton(p.appUrl, `In der ${vocab.kitty} ansehen`)}
${renderHintBlock(
  "Sobald du an den Anbieter gezahlt hast, erfasse die Zahlung in der App beim Posten unter „Zahlung an Anbieter erfassen“.",
)}`;

  const html = renderMailShell({
    title: subject,
    preheader: `Noch ${fmtEuro(p.providerOpen)} an den Anbieter überweisen — ${p.item.label}`,
    subtitle: p.tripName,
    body,
  });

  const text = `Zahlung an den Anbieter steht an
${p.tripName}

Hi ${p.recipientName},

am ${p.providerDueDate} ist der Posten ${title} für ${tripPhrase(p.tripType)} ${p.tripName} beim Anbieter fällig.

  Soll Anbieter:               ${fmtEuro(p.providerSoll)}
  ${vocab.crew} bei dir eingegangen: ${fmtEuro(p.crewPaid)} von ${fmtEuro(p.crewSoll)}
  An den Anbieter überwiesen:  ${fmtEuro(p.providerPaid)}
  NOCH ZU ÜBERWEISEN:          ${fmtEuro(p.providerOpen)}
${p.ownOpen > 0.005 ? `\nDein eigener Anteil (${fmtEuro(p.ownOpen)}) ist noch nicht als Selbstverrechnung erfasst.\n` : ""}
Sobald du an den Anbieter gezahlt hast, erfasse die Zahlung in der App beim Posten unter „Zahlung an Anbieter erfassen“.

In der App: ${p.appUrl}

${FOOTER}`;

  return { html, text, subject };
}
