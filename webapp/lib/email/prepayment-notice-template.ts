/**
 * Generische Info-Mail für Anzahlungs-Aktionen, die von einer DRITTEN Person
 * (Admin, Co-Skipper, Vorstrecker) ausgelöst werden — und über die der
 * Betroffene normalerweise informiert werden sollte.
 *
 * Drei Varianten (`kind`):
 *   - "payment_recorded"  → Eine Anzahlung wurde im Namen von X erfasst.
 *                           Empfänger: die Crew-Person UND der Vorstrecker
 *                           (sofern Actor ≠ Vorstrecker).
 *   - "payment_confirmed" → Eine Selbstmeldung von X wurde bestätigt.
 *                           Empfänger: Vorstrecker, falls Actor ≠ Vorstrecker.
 *   - "payment_rejected"  → Eine Selbstmeldung von X wurde abgelehnt.
 *                           Empfänger: Vorstrecker und (sofern unterscheidbar)
 *                           die Crew-Person, damit sie reagieren kann.
 *
 * Layout via mail-shell.
 */

import { renderMailShell, renderActionButton, renderHintBlock, escapeHtml, fmtEuro } from "./mail-shell";

export type PrepaymentNoticeKind = "payment_recorded" | "payment_confirmed" | "payment_rejected";

export type PrepaymentNoticeParams = {
  kind: PrepaymentNoticeKind;
  recipientName: string;
  actorName: string;
  /** Name der Crew-Person, um die es bei der Buchung geht. */
  subjectPersonName: string;
  /** Optional: Name des Vorstreckers, wenn der Empfänger nicht selbst der Vorstrecker ist. */
  advancerName?: string;
  amount: number;
  trancheLabel: string;
  tripName: string;
  appUrl: string;
};

export function renderPrepaymentNoticeMail(p: PrepaymentNoticeParams): {
  html: string;
  text: string;
  subject: string;
} {
  let subject: string;
  let headline: string;
  let introText: string;
  let pillColor = "#587EA8";

  switch (p.kind) {
    case "payment_recorded":
      subject = `Anzahlung erfasst: ${p.subjectPersonName} (${fmtEuro(p.amount)})`;
      headline = "Anzahlung wurde erfasst";
      introText =
        p.recipientName === p.subjectPersonName
          ? `${p.actorName} hat soeben eine Anzahlung in Höhe von ${fmtEuro(p.amount)} für ${escapeHtml(p.trancheLabel)} im Namen von dir erfasst.`
          : `${p.actorName} hat soeben eine Anzahlung von ${p.subjectPersonName} in Höhe von ${fmtEuro(p.amount)} für ${escapeHtml(p.trancheLabel)} in der Bordkasse erfasst.`;
      pillColor = "#1E8449";
      break;
    case "payment_confirmed":
      subject = `Anzahlung bestätigt: ${p.subjectPersonName} (${fmtEuro(p.amount)})`;
      headline = "Anzahlung wurde bestätigt";
      introText = `${p.actorName} hat soeben die Selbstmeldung von ${p.subjectPersonName} in Höhe von ${fmtEuro(p.amount)} für ${escapeHtml(p.trancheLabel)} als bestätigt markiert.`;
      pillColor = "#1E8449";
      break;
    case "payment_rejected":
      subject = `Anzahlung abgelehnt: ${p.subjectPersonName} (${fmtEuro(p.amount)})`;
      headline = "Anzahlung wurde abgelehnt";
      introText = `${p.actorName} hat soeben die Selbstmeldung von ${p.subjectPersonName} in Höhe von ${fmtEuro(p.amount)} für ${escapeHtml(p.trancheLabel)} abgelehnt.`;
      pillColor = "#A93226";
      break;
  }

  const followupText =
    p.kind === "payment_rejected"
      ? "Falls die Ablehnung ein Versehen war, sprich kurz mit der vorstreckenden Person oder dem Skipper — die Buchung kann neu erfasst werden."
      : "Falls etwas nicht stimmt, sprich kurz mit der vorstreckenden Person oder dem Skipper — Buchungen können in der App noch geändert werden.";

  const detailLine = `${p.subjectPersonName} · ${escapeHtml(p.trancheLabel)} · ${fmtEuro(p.amount)}`;

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
                  ${introText}
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:0 32px 8px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding:12px 16px;background-color:#F4F2EC;border-left:3px solid ${pillColor};border-radius:6px;font-size:14px;color:#1A2533;">
                      ${detailLine}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:16px 32px 8px 32px;">
                <p style="margin:0;font-size:14px;line-height:1.55;color:#1A2533;">
                  ${escapeHtml(followupText)}
                </p>
              </td>
            </tr>
${renderActionButton(p.appUrl, "In der Bordkasse ansehen")}
${renderHintBlock(
  p.advancerName
    ? `Du bekommst diese Mail, weil ${p.advancerName} für diesen Törn vorstreckt und ${p.actorName} eine Aktion zu deiner Anzahlung ausgelöst hat.`
    : `Du bekommst diese Mail, weil die Anzahlungen an dich gehen (du streckst für diesen Törn vor). Aktionen anderer Personen — wie ${p.actorName} hier — landen automatisch bei dir.`,
)}`;

  const html = renderMailShell({
    title: subject,
    preheader: `${p.actorName}: ${p.subjectPersonName} · ${p.trancheLabel} · ${fmtEuro(p.amount)}`,
    subtitle: p.tripName,
    body,
  });

  const text = `${headline}
${p.tripName}

Hi ${p.recipientName},

${stripTags(introText)}

  ${p.subjectPersonName} · ${p.trancheLabel} · ${fmtEuro(p.amount)}

${followupText}

In der App: ${p.appUrl}

—
Bordkasse · Faire Kostenaufteilung auf Segel-Törns
`;

  return { html, text, subject };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}
