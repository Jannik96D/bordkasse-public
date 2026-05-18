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
 * Layout 1:1 wie Magic-Link- und Settlement-Mail (Card auf #FAFBFC, Logo
 * oben, table-basiert für Outlook/Gmail-Kompatibilität).
 *
 * Farben (Single Source of Truth: docs/design-system.md):
 *   #114884 primary       Texte, Akzente
 *   #1D4281 primary-dark  Sub-Headlines
 *   #587EA8 mid-blue      Hint-Text
 *   #D6E1EE soft-blue     Borders
 *   #1A2533 ink           Body
 *   #FAFBFC paper         Page-Background
 *   #1E8449 success       Bezahlt
 *   #F4F2EC paper-soft    Detail-Pille
 */

const SITE_URL = process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://bordkasse.dieter.ms";

export type DebtSettledMailParams = {
  recipientName: string;
  /** Empfänger-Rolle: "debtor" hat selbst abgehakt, "creditor" wird benachrichtigt. */
  recipientRole: "debtor" | "creditor";
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

const fmtEuro = (n: number) =>
  new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(n);

export function renderDebtSettledMail(p: DebtSettledMailParams): {
  html: string;
  text: string;
  subject: string;
} {
  const isDebtor = p.recipientRole === "debtor";
  const subject = isDebtor
    ? `Bestätigung: Zahlung an ${p.creditorName} abgehakt`
    : `${p.debtorName} hat seine Zahlung an dich abgehakt`;
  const headline = isDebtor ? "Zahlung als erledigt markiert" : "Zahlung wurde abgehakt";
  const introText = isDebtor
    ? `du hast soeben in der Bordkasse abgehakt, dass du deine Schuld in Höhe von ${fmtEuro(p.amount)} an ${p.creditorName} bezahlt hast.`
    : `${p.debtorName} hat soeben in der Bordkasse markiert, dass die Zahlung in Höhe von ${fmtEuro(p.amount)} an dich erledigt ist.`;
  const followupText = isDebtor
    ? "Diese Mail dient als Quittung. Falls du dich vertan hast, kannst du das Häkchen in der App auch wieder entfernen."
    : "Bitte prüfe, ob das Geld bei dir angekommen ist. Falls etwas nicht stimmt, sprich kurz mit dem Schuldner oder dem Skipper — das Häkchen kann in der App auch wieder entfernt werden.";

  const detailLine = `${p.debtorName} → ${p.creditorName} · ${fmtEuro(p.amount)}`;

  const html = `<!DOCTYPE html>
<html lang="de">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#FAFBFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1A2533;">
    <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">
      ${escapeHtml(detailLine)} — ${escapeHtml(p.tripName)}
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#FAFBFC;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#FFFFFF;border:1px solid #D6E1EE;border-radius:12px;overflow:hidden;">
            <!-- Header mit Logo -->
            <tr>
              <td align="center" style="padding:32px 24px 8px 24px;">
                <img src="${SITE_URL}/logo.png" alt="Bordkasse" width="160" height="123"
                     style="display:block;width:160px;height:auto;border:0;outline:none;text-decoration:none;">
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 24px 8px 24px;">
                <h1 style="margin:0;font-size:24px;line-height:1.25;font-weight:700;color:#114884;letter-spacing:-0.01em;">
                  Bordkasse
                </h1>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:4px 24px 0 24px;">
                <p style="margin:0;font-size:14px;color:#587EA8;">
                  ${escapeHtml(p.tripName)} · ${escapeHtml(p.tripDates)}
                </p>
              </td>
            </tr>

            <!-- Hauptinhalt -->
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

            <!-- Detail-Pille -->
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

            <!-- Followup -->
            <tr>
              <td style="padding:16px 32px 8px 32px;">
                <p style="margin:0;font-size:14px;line-height:1.55;color:#1A2533;">
                  ${escapeHtml(followupText)}
                </p>
              </td>
            </tr>

            <!-- Button -->
            <tr>
              <td align="center" style="padding:24px 32px 8px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td align="center" style="border-radius:8px;background-color:#114884;">
                      <a href="${p.appUrl}"
                         style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px;">
                        Schulden in der App ansehen
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Fallback-Link -->
            <tr>
              <td style="padding:8px 32px 16px 32px;">
                <p style="margin:0;font-size:12px;line-height:1.5;color:#587EA8;text-align:center;">
                  Funktioniert der Button nicht? Kopiere diesen Link in deinen Browser:
                </p>
                <p style="margin:6px 0 0 0;font-size:11px;line-height:1.5;color:#587EA8;text-align:center;word-break:break-all;">
                  <a href="${p.appUrl}" style="color:#114884;text-decoration:underline;">${escapeHtml(p.appUrl)}</a>
                </p>
              </td>
            </tr>

            <!-- Trenner -->
            <tr>
              <td style="padding:0 32px;">
                <hr style="border:none;border-top:1px solid #D6E1EE;margin:8px 0;">
              </td>
            </tr>

            <!-- Hinweis -->
            <tr>
              <td style="padding:16px 32px 24px 32px;">
                <p style="margin:0;font-size:12px;line-height:1.55;color:#587EA8;">
                  Diese Mail wurde automatisch verschickt, sobald jemand eine Zahlung in der App
                  abhakt — so wissen beide Seiten Bescheid und können den Stand in Ruhe prüfen.
                </p>
              </td>
            </tr>
          </table>

          <!-- Footer -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
            <tr>
              <td align="center" style="padding:16px 24px;">
                <p style="margin:0;font-size:11px;line-height:1.6;color:#7A8DA1;">
                  Bordkasse · Faire Kostenaufteilung auf Segel-Törns<br>
                  <a href="${SITE_URL}/datenschutz" style="color:#587EA8;text-decoration:underline;">Datenschutz</a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" :
    ch === "<" ? "&lt;" :
    ch === ">" ? "&gt;" :
    ch === '"' ? "&quot;" : "&#39;",
  );
}
