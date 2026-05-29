/**
 * HTML- und Text-Template für die Benachrichtigung, dass eine Schuld in der
 * App als bezahlt abgehakt wurde.
 *
 * Zwei Varianten, je nach Empfänger:
 *   - "debtor"   → der Schuldner selbst hat abgehakt; bekommt eine
 *                  Bestätigungsmail ("Du hast deine Zahlung an X als
 *                  erledigt markiert").
 *   - "creditor" → der Gläubiger bekommt die Info, dass der Schuldner die
 *                  Zahlung abgehakt hat ("X hat seine Zahlung an dich als
 *                  erledigt markiert — bitte prüfe, ob das Geld angekommen
 *                  ist").
 *
 * Layout über `mail-shell.ts` — identisch zu allen anderen Bordkasse-Mails.
 */

import { renderMailShell, renderActionButton, renderHintBlock, escapeHtml, fmtEuro } from "./mail-shell";

export type DebtSettledMailParams = {
  recipientName: string;
  /** Empfänger-Rolle: ist der Empfänger Schuldner oder Gläubiger? */
  recipientRole: "debtor" | "creditor";
  /**
   * Akteur-Rolle: wer hat das Häkchen tatsächlich gesetzt?
   *   - "debtor":   der Schuldner selbst (meldet seine Zahlung)
   *   - "creditor": der Gläubiger (bestätigt Empfang)
   *   - "other":    eine dritte Person, z. B. Admin/Skipper, der für einen
   *                 der beiden abhakt
   */
  actorRole: "debtor" | "creditor" | "other";
  /** Anzeigename des Akteurs — nur bei actorRole="other" relevant. */
  actorName?: string;
  /** Name des Schuldners (z. B. „Tom"). */
  debtorName: string;
  /** Name des Gläubigers (z. B. „Otto"). */
  creditorName: string;
  amount: number;
  tripName: string;
  tripDates: string;
  /** Link zur Schulden-Seite des Trips. */
  appUrl: string;
};

export function renderDebtSettledMail(p: DebtSettledMailParams): {
  html: string;
  text: string;
  subject: string;
} {
  const recipientIsDebtor = p.recipientRole === "debtor";
  const actorLabel = p.actorRole === "other" ? p.actorName ?? "Jemand" : "";
  const amount = fmtEuro(p.amount);

  let subject: string;
  let headline: string;
  let introText: string;
  let followupText: string;

  if (recipientIsDebtor) {
    if (p.actorRole === "debtor") {
      subject = `Bestätigung: Zahlung an ${p.creditorName} abgehakt`;
      headline = "Zahlung als erledigt markiert";
      introText = `du hast soeben in der Bordkasse abgehakt, dass du deine Schuld in Höhe von ${amount} an ${p.creditorName} bezahlt hast.`;
      followupText = "Falls du dich vertan hast, kannst du das Häkchen in der App auch wieder entfernen.";
    } else if (p.actorRole === "creditor") {
      subject = `${p.creditorName} hat deine Zahlung als erhalten bestätigt`;
      headline = "Zahlung als angekommen bestätigt";
      introText = `${p.creditorName} hat soeben in der Bordkasse bestätigt, dass deine Zahlung in Höhe von ${amount} angekommen ist. Damit ist die Schuld erledigt.`;
      followupText = "Falls das ein Versehen war, kann das Häkchen in der App auch wieder entfernt werden.";
    } else {
      subject = `Zahlung an ${p.creditorName} wurde abgehakt`;
      headline = "Zahlung wurde abgehakt";
      introText = `${actorLabel} hat soeben in der Bordkasse markiert, dass deine Zahlung in Höhe von ${amount} an ${p.creditorName} erledigt ist.`;
      followupText = "Falls das ein Versehen war, sprich kurz mit dem Skipper — das Häkchen kann in der App auch wieder entfernt werden.";
    }
  } else {
    if (p.actorRole === "debtor") {
      subject = `${p.debtorName} hat seine Zahlung an dich abgehakt`;
      headline = "Zahlung wurde abgehakt";
      introText = `${p.debtorName} hat soeben in der Bordkasse markiert, dass die Zahlung in Höhe von ${amount} an dich erledigt ist.`;
      followupText = "Falls etwas nicht stimmt, sprich kurz mit dem Schuldner oder dem Skipper — das Häkchen kann in der App auch wieder entfernt werden.";
    } else if (p.actorRole === "creditor") {
      subject = `Bestätigung: Zahlung von ${p.debtorName} als erhalten markiert`;
      headline = "Empfang bestätigt";
      introText = `du hast soeben in der Bordkasse abgehakt, dass die Zahlung von ${p.debtorName} in Höhe von ${amount} bei dir angekommen ist.`;
      followupText = "Falls du dich vertan hast, kannst du das Häkchen in der App auch wieder entfernen.";
    } else {
      subject = `Zahlung von ${p.debtorName} an dich wurde abgehakt`;
      headline = "Zahlung wurde abgehakt";
      introText = `${actorLabel} hat soeben in der Bordkasse markiert, dass die Zahlung von ${p.debtorName} in Höhe von ${amount} an dich erledigt ist.`;
      followupText = "Falls etwas nicht stimmt, sprich mit dem Skipper — das Häkchen kann in der App auch wieder entfernt werden.";
    }
  }

  const detailLine = `${p.debtorName} → ${p.creditorName} · ${amount}`;

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
                  ${escapeHtml(introText)}
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:0 32px 8px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding:12px 16px;background-color:#F4F2EC;border-left:3px solid #1E8449;border-radius:6px;font-size:14px;color:#1A2533;">
                      <strong>${escapeHtml(p.debtorName)}</strong>
                      &nbsp;→&nbsp;
                      <strong>${escapeHtml(p.creditorName)}</strong>
                      &nbsp;·&nbsp;
                      <span style="color:#1E8449;font-weight:600;">${escapeHtml(fmtEuro(p.amount))}</span>
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
${renderActionButton(p.appUrl, "Schulden in der App ansehen")}
${renderHintBlock(
  "Diese Mail wurde automatisch verschickt, sobald jemand eine Zahlung in der App abhakt — so wissen beide Seiten Bescheid und können den Stand in Ruhe prüfen.",
)}`;

  const html = renderMailShell({
    title: subject,
    preheader: `${detailLine} — ${p.tripName}`,
    subtitle: `${p.tripName} · ${p.tripDates}`,
    body,
  });

  const text = `${headline}
${p.tripName} · ${p.tripDates}

Hi ${p.recipientName},

${introText}

  ${detailLine}

${followupText}

Schulden in der App: ${p.appUrl}

—
Bordkasse · Faire Kostenaufteilung auf Segel-Törns
`;

  return { html, text, subject };
}
