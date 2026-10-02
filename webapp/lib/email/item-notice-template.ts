/**
 * Mails zu Zahlungen für Reise-Posten (PR6) — Pendant zu
 * payment-pending-template (Selbstmeldung) und prepayment-notice-template
 * (Erfassung/Bestätigung/Ablehnung) der Charteranzahlung, aber mit
 * Posten-Kontext („An-/Abreise: Flüge") statt „N. Anzahlung".
 *
 *   • renderItemPendingMail — an den Posten-Empfänger: X meldet eine Zahlung.
 *   • renderItemNoticeMail  — Info an zahlende Person bzw. Empfänger.
 *
 * ⚠️ Escaping: Bezeichnung, Kategorie, Törnname, Notiz und alle Namen sind
 * frei editierbar → im HTML IMMER durch escapeHtml. Die Text-Variante bleibt
 * roh (Plaintext). Wero kommt in diesen Mails bewusst nicht vor (es geht um
 * eine bereits geleistete Zahlung).
 */

import { renderMailShell, renderActionButton, renderHintBlock, escapeHtml, fmtEuro } from "./mail-shell";
import { tripVocab } from "@/lib/trip-vocab";
import type { ItemNoticeKind } from "@/lib/prepayments/notify";

export interface ItemMailInfo {
  label: string;
  categoryName: string | null;
}

export const itemMailTitle = (i: ItemMailInfo): string => (i.categoryName ? `${i.categoryName}: ${i.label}` : i.label);
const FOOTER = "—\nBordkasse · Faire Kostenaufteilung auf Segeltörns\n";

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
   * der Empfänger (Name hier) keine E-Mail-Adresse hinterlegt hat.
   */
  onBehalfOfName?: string;
}

export function renderItemPendingMail(p: ItemPendingParams): { html: string; text: string; subject: string } {
  const vocab = tripVocab(p.tripType);
  const title = itemMailTitle(p.item);
  const subject = `Zahlung gemeldet: ${p.reporterName} – ${p.item.label} (${fmtEuro(p.amount)})`;
  const noteBlock = p.note
    ? `
            <tr>
              <td style="padding:8px 32px 0 32px;">
                <p style="margin:0;padding:10px 14px;background-color:#FDF6DC;border-left:3px solid #C8A51E;font-size:13px;color:#1A2533;border-radius:4px;">
                  <strong>Notiz von ${escapeHtml(p.reporterName)}:</strong> ${escapeHtml(p.note)}
                </p>
              </td>
            </tr>`
    : "";

  const body = `
            <tr>
              <td style="padding:32px 32px 8px 32px;">
                <h2 style="margin:0 0 12px 0;font-size:18px;font-weight:600;color:#1D4281;">
                  Zahlung gemeldet
                </h2>
                <p style="margin:0 0 12px 0;font-size:15px;line-height:1.55;color:#1A2533;">
                  Hi ${escapeHtml(p.recipientName)},
                </p>
                <p style="margin:0;font-size:15px;line-height:1.55;color:#1A2533;">
                  <strong>${escapeHtml(p.reporterName)}</strong> meldet, den Anteil am Posten
                  <strong>${escapeHtml(title)}</strong> an ${p.onBehalfOfName ? `<strong>${escapeHtml(p.onBehalfOfName)}</strong>` : "dich"} gezahlt zu haben:
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:14px 32px 0 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F4F2EC;border-radius:6px;">
                  <tr>
                    <td style="padding:14px;font-size:14px;color:#1A2533;">
                      <strong>Posten:</strong> ${escapeHtml(title)}<br/>
                      <strong>Gezahlt am:</strong> ${escapeHtml(p.date)}<br/>
                      <strong>Betrag:</strong> <strong style="color:#114884;">${fmtEuro(p.amount)}</strong>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
${noteBlock}
${renderActionButton(p.appUrl, `In der ${vocab.kitty} bestätigen`)}
${renderHintBlock(
  p.onBehalfOfName
    ? `Du bekommst diese Mail stellvertretend, weil ${p.onBehalfOfName} keine E-Mail-Adresse hinterlegt hat. Bitte kläre mit ${p.onBehalfOfName}, ob das Geld angekommen ist, und bestätige oder lehne die Meldung in der App ab — vorher zählt sie nicht.`
    : "Du bekommst diese Mail, weil das Geld für diesen Posten an dich geht. Bestätige die Zahlung in der App, sobald sie bei dir angekommen ist — vorher zählt sie nicht.",
)}`;

  const html = renderMailShell({
    title: subject,
    preheader: `${p.reporterName} meldet ${fmtEuro(p.amount)} für ${p.item.label} — bitte bestätigen.`,
    subtitle: p.tripName,
    body,
  });

  const text = `Zahlung gemeldet
${p.tripName}

Hi ${p.recipientName},

${p.reporterName} meldet, den Anteil am Posten ${title} an ${p.onBehalfOfName ?? "dich"} gezahlt zu haben:

  Posten:     ${title}
  Gezahlt am: ${p.date}
  Betrag:     ${fmtEuro(p.amount)}
${p.note ? `  Notiz:      ${p.note}\n` : ""}
${p.onBehalfOfName ? `Du bekommst diese Mail stellvertretend, weil ${p.onBehalfOfName} keine E-Mail-Adresse hinterlegt hat.\n` : ""}Bitte in der App bestätigen oder ablehnen: ${p.appUrl}

${FOOTER}`;

  return { html, text, subject };
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

export function renderItemNoticeMail(p: ItemNoticeParams): { html: string; text: string; subject: string } {
  const vocab = tripVocab(p.tripType);
  const title = itemMailTitle(p.item);
  const a = escapeHtml(p.actorName);
  const eTitle = escapeHtml(title);
  const amount = fmtEuro(p.amount);
  const isPayer = p.role === "payer";
  // „deine Zahlung" für die zahlende Person, sonst „die Zahlung von X".
  const whoseHtml = isPayer ? "deine Zahlung" : `die Zahlung von ${escapeHtml(p.payerName)}`;
  const whoseText = isPayer ? "deine Zahlung" : `die Zahlung von ${p.payerName}`;

  let subject: string;
  let headline: string;
  let introHtml: string;
  let introText: string;
  let pill = "#1E8449";
  switch (p.kind) {
    case "item_payment_recorded":
      subject = `Zahlung erfasst: ${p.item.label} (${amount})`;
      headline = "Zahlung wurde erfasst";
      introHtml = `${a} hat ${whoseHtml} über ${amount} für den Posten <strong>${eTitle}</strong> in der ${vocab.kitty} erfasst.`;
      introText = `${p.actorName} hat ${whoseText} über ${amount} für den Posten ${title} in der ${vocab.kitty} erfasst.`;
      break;
    case "item_payment_confirmed":
      subject = `Zahlung bestätigt: ${p.item.label} (${amount})`;
      headline = "Zahlung wurde bestätigt";
      introHtml = `${a} hat ${whoseHtml} über ${amount} für den Posten <strong>${eTitle}</strong> bestätigt. Sie zählt ab jetzt.`;
      introText = `${p.actorName} hat ${whoseText} über ${amount} für den Posten ${title} bestätigt. Sie zählt ab jetzt.`;
      break;
    case "item_payment_rejected":
      subject = `Zahlung abgelehnt: ${p.item.label} (${amount})`;
      headline = "Zahlung wurde abgelehnt";
      introHtml = `${a} hat ${isPayer ? "deine Meldung" : `die Meldung von ${escapeHtml(p.payerName)}`} über ${amount} für den Posten <strong>${eTitle}</strong> abgelehnt.`;
      introText = `${p.actorName} hat ${isPayer ? "deine Meldung" : `die Meldung von ${p.payerName}`} über ${amount} für den Posten ${title} abgelehnt.`;
      pill = "#A93226";
      break;
  }

  const followup =
    p.kind === "item_payment_rejected"
      ? isPayer
        ? `Der Anteil ist damit wieder offen. Falls die Ablehnung ein Versehen war, sprich kurz mit ${p.payeeName} — du kannst die Zahlung danach erneut melden.`
        : "Der Anteil ist damit wieder offen."
      : `Falls etwas nicht stimmt, sprich kurz mit ${isPayer ? p.payeeName : p.actorName} — Zahlungen lassen sich in der App korrigieren.`;

  const detailHtml = `${escapeHtml(p.payerName)} · ${eTitle} · ${amount}`;
  const detailText = `${p.payerName} · ${title} · ${amount}`;
  const hint = isPayer
    ? `Du bekommst diese Mail, weil ${p.actorName} eine Aktion zu deiner Zahlung für diesen Posten ausgelöst hat.`
    : `Du bekommst diese Mail, weil das Geld für diesen Posten an dich geht und ${p.actorName} eine Aktion dazu ausgelöst hat.`;

  const body = `
            <tr>
              <td style="padding:32px 32px 8px 32px;">
                <h2 style="margin:0 0 12px 0;font-size:18px;font-weight:600;color:#1D4281;">
                  ${escapeHtml(headline)}
                </h2>
                <p style="margin:0 0 12px 0;font-size:15px;line-height:1.55;color:#1A2533;">
                  Hi ${escapeHtml(p.recipientName)},
                </p>
                <p style="margin:0 0 16px 0;font-size:15px;line-height:1.55;color:#1A2533;">
                  ${introHtml}
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:0 32px 8px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding:12px 16px;background-color:#F4F2EC;border-left:3px solid ${pill};border-radius:6px;font-size:14px;color:#1A2533;">
                      ${detailHtml}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:16px 32px 8px 32px;">
                <p style="margin:0;font-size:14px;line-height:1.55;color:#1A2533;">
                  ${escapeHtml(followup)}
                </p>
              </td>
            </tr>
${renderActionButton(p.appUrl, `In der ${vocab.kitty} ansehen`)}
${renderHintBlock(hint)}`;

  const html = renderMailShell({
    title: subject,
    preheader: `${p.actorName}: ${detailText}`,
    subtitle: p.tripName,
    body,
  });

  const text = `${headline}
${p.tripName}

Hi ${p.recipientName},

${introText}

  ${detailText}

${followup}

In der App: ${p.appUrl}

${FOOTER}`;

  return { html, text, subject };
}
