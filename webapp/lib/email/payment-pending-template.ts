/**
 * Mail an Skipper/Vorstrecker, wenn ein Crew-Mitglied eine Anzahlung selbst
 * meldet.
 *
 * Spec: docs/prepayments.md §Phase 2.
 * Layout über `mail-shell.ts` — identisch zu allen anderen Bordkasse-Mails.
 */

import { renderMailShell, renderActionButton, renderHintBlock, escapeHtml } from "./mail-shell";

export type PaymentPendingParams = {
  /** Empfänger der Mail — typischerweise der Vorstrecker (Default = Skipper). */
  skipperName: string;
  reporterName: string;
  tripName: string;
  trancheLabel: string;
  trancheDueDate: string;   // "15.07.2026"
  amount: number;
  note?: string | null;
  appUrl: string;          // Link auf /trips/{id}/prepayments
};

const fmtEuro = (n: number) =>
  new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(n);

export function renderPaymentPendingMail(p: PaymentPendingParams): {
  html: string;
  text: string;
  subject: string;
} {
  const subject = `Bordkasse-Anzahlung gemeldet: ${p.reporterName} (${fmtEuro(p.amount)})`;
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
                  Anzahlung gemeldet
                </h2>
                <p style="margin:0 0 12px 0;font-size:15px;line-height:1.55;color:#1A2533;">
                  Hi ${escapeHtml(p.skipperName)},
                </p>
                <p style="margin:0;font-size:15px;line-height:1.55;color:#1A2533;">
                  <strong>${escapeHtml(p.reporterName)}</strong> hat eine Anzahlung gemeldet:
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:14px 32px 0 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F4F2EC;border-radius:6px;">
                  <tr>
                    <td style="padding:14px;font-size:14px;color:#1A2533;">
                      <strong>Tranche:</strong> ${escapeHtml(p.trancheLabel)}<br/>
                      <strong>Fällig:</strong> ${escapeHtml(p.trancheDueDate)}<br/>
                      <strong>Betrag:</strong> <strong style="color:#114884;">${fmtEuro(p.amount)}</strong>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
${noteBlock}
${renderActionButton(p.appUrl, "In der Bordkasse bestätigen")}
${renderHintBlock(
  "Du bekommst diese Mail, weil du der Vorstrecker für diesen Törn bist. Bestätige die Zahlung in der App, sobald sie auf deinem Konto angekommen ist — sonst zählt sie nicht zur Crew-Bilanz.",
)}`;

  const html = renderMailShell({
    title: subject,
    preheader: `${p.reporterName} hat ${fmtEuro(p.amount)} gemeldet — bitte bestätigen.`,
    subtitle: p.tripName,
    body,
  });

  const text = `Anzahlung gemeldet
${p.tripName}

Hi ${p.skipperName},

${p.reporterName} hat eine Anzahlung gemeldet:

  Tranche: ${p.trancheLabel} (fällig ${p.trancheDueDate})
  Betrag:  ${fmtEuro(p.amount)}
${p.note ? `  Notiz:   ${p.note}\n` : ""}
Bitte in der App bestätigen oder ablehnen: ${p.appUrl}

—
Bordkasse · Faire Kostenaufteilung auf Segel-Törns
`;

  return { html, text, subject };
}
