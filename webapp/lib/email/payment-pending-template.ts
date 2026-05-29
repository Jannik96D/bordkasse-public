/**
 * Mail an Skipper, wenn ein Crew-Mitglied eine Anzahlung selbst meldet.
 * Spec: docs/prepayments.md §Phase 2.
 *
 * Design 1:1 wie prepayment-reminder-template.ts.
 */

const SITE_URL = process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://bordkasse.dieter.ms";

export type PaymentPendingParams = {
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

export function renderPaymentPendingMail(p: PaymentPendingParams): { html: string; text: string; subject: string } {
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

  const html = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#FAFBFC;font-family:Arial,Helvetica,sans-serif;color:#1A2533;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#FAFBFC;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;border:1px solid #D6E1EE;overflow:hidden;">
          <tr>
            <td style="padding:32px 32px 12px 32px;text-align:center;">
              <div style="font-size:22px;font-weight:700;color:#114884;letter-spacing:-0.5px;">⛵ Bordkasse</div>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 8px 32px;">
              <h1 style="margin:0;font-size:20px;font-weight:700;color:#1D4281;">Anzahlung gemeldet</h1>
              <p style="margin:6px 0 0 0;color:#587EA8;font-size:14px;">${escapeHtml(p.tripName)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px 0 32px;">
              <p style="margin:0;font-size:15px;line-height:1.6;color:#1A2533;">
                Hi ${escapeHtml(p.skipperName)},<br/>
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
          <tr>
            <td style="padding:22px 32px 32px 32px;text-align:center;">
              <a href="${escapeAttr(p.appUrl)}" style="display:inline-block;padding:12px 22px;background-color:#114884;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">
                In der Bordkasse bestätigen
              </a>
            </td>
          </tr>
        </table>
        <p style="margin:18px 0 0 0;color:#587EA8;font-size:12px;text-align:center;">
          ⛵ Bordkasse für Segel-Törns · <a href="${escapeAttr(SITE_URL)}" style="color:#587EA8;">${escapeHtml(SITE_URL.replace(/^https?:\/\//, ""))}</a>
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `Hi ${p.skipperName},

${p.reporterName} hat eine Anzahlung gemeldet für den Törn ${p.tripName}:

  Tranche: ${p.trancheLabel} (fällig ${p.trancheDueDate})
  Betrag:  ${fmtEuro(p.amount)}
${p.note ? `  Notiz:   ${p.note}\n` : ""}
Bitte in der App bestätigen oder ablehnen: ${p.appUrl}

⛵ Bordkasse für Segel-Törns
`;

  return { html, text, subject };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
