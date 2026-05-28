/**
 * HTML- und Text-Template für die Anzahlungs-Erinnerungs-Mail.
 * Layout 1:1 nach settlement-template.ts (Card auf #FAFBFC, Logo, Bordkasse-
 * Farbpalette, table-basiert für Outlook).
 *
 * Spec: docs/prepayments.md §Erinnerungsmail
 */

const SITE_URL = process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://bordkasse.dieter.ms";

export type ReminderTrancheItem = {
  label: string;
  due_date: string;       // formatiert "15.07.2026"
  amount_due: number;     // verbleibender Restbetrag
  amount_total: number;   // Gesamt-Soll der Person für diese Tranche
  wero_request_link?: string | null;
};

export type PrepaymentReminderParams = {
  recipientName: string;
  tripName: string;
  tranches: ReminderTrancheItem[];
  weroId?: string | null;
  skipperName: string;
  appUrl: string;
};

const fmtEuro = (n: number) =>
  new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(n);

export function renderPrepaymentReminderMail(p: PrepaymentReminderParams): { html: string; text: string; subject: string } {
  const subject = `Erinnerung Bordkasse-Anzahlung: ${p.tripName}`;
  const totalOpen = p.tranches.reduce((s, t) => s + t.amount_due, 0);

  const trancheRows = p.tranches
    .map((t) => {
      const link = t.wero_request_link
        ? `<a href="${escapeAttr(t.wero_request_link)}" style="color:#114884;text-decoration:underline;">Per Wero zahlen</a>`
        : "";
      return `
        <tr>
          <td style="padding:10px 14px;background-color:#F4F2EC;border-radius:6px;font-size:14px;color:#1A2533;">
            <strong>${escapeHtml(t.label)}</strong> &nbsp;
            <span style="color:#587EA8;">fällig ${escapeHtml(t.due_date)}</span><br/>
            Offen: <strong>${fmtEuro(t.amount_due)}</strong>
            ${t.amount_total !== t.amount_due ? ` (von ${fmtEuro(t.amount_total)})` : ""}
            ${link ? `<br/>${link}` : ""}
          </td>
        </tr>
        <tr><td style="height:6px;line-height:6px;font-size:6px;">&nbsp;</td></tr>`;
    })
    .join("");

  const weroBlock = p.weroId
    ? `
        <tr>
          <td style="padding:8px 32px 0 32px;">
            <p style="margin:0;padding:10px 14px;background-color:#FDF6DC;border-left:3px solid #C8A51E;font-size:13px;color:#1A2533;border-radius:4px;">
              <strong>Wero (${escapeHtml(p.skipperName)}):</strong> ${escapeHtml(p.weroId)}<br/>
              <span style="color:#587EA8;">Verwendungszweck: Anzahlung ${escapeHtml(p.tripName)}</span>
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
              <h1 style="margin:0;font-size:20px;font-weight:700;color:#1D4281;">Erinnerung: Anzahlung</h1>
              <p style="margin:6px 0 0 0;color:#587EA8;font-size:14px;">${escapeHtml(p.tripName)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px 0 32px;">
              <p style="margin:0;font-size:15px;line-height:1.6;color:#1A2533;">
                Hi ${escapeHtml(p.recipientName)},<br/>
                hier deine offenen Anzahlungs-Tranchen. Insgesamt offen: <strong>${fmtEuro(totalOpen)}</strong>.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px 0 32px;">
              <h3 style="margin:0 0 10px 0;font-size:15px;font-weight:600;color:#114884;">Offene Tranchen</h3>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                ${trancheRows}
              </table>
            </td>
          </tr>
          ${weroBlock}
          <tr>
            <td style="padding:22px 32px 32px 32px;text-align:center;">
              <a href="${escapeAttr(p.appUrl)}" style="display:inline-block;padding:12px 22px;background-color:#114884;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">
                In der Bordkasse anzeigen
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

  const trancheText = p.tranches
    .map((t) => `  - ${t.label} (fällig ${t.due_date}): offen ${fmtEuro(t.amount_due)}${t.wero_request_link ? `\n    Wero: ${t.wero_request_link}` : ""}`)
    .join("\n");

  const text = `Hi ${p.recipientName},

Erinnerung an deine Anzahlung für den Törn ${p.tripName}.

Offene Tranchen:
${trancheText}

Gesamt offen: ${fmtEuro(totalOpen)}

${p.weroId ? `Wero (${p.skipperName}): ${p.weroId}\nVerwendungszweck: Anzahlung ${p.tripName}\n\n` : ""}In der App: ${p.appUrl}

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
