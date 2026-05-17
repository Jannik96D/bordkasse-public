/**
 * HTML- und Text-Template für die "Abrechnung-verschickt"-Mail an jedes
 * Crew-Mitglied. Inhalt ist personalisiert auf den eigenen Saldo + die
 * konkreten Zahlungsanweisungen (du-zahlst-an / an-dich-zahlt).
 *
 * Layout 1:1 wie `supabase/email-templates/magic-link.html` — Card auf
 * #FAFBFC-Hintergrund, Logo oben, Bordkasse-Farbpalette, table-basiert für
 * Mail-Client-Kompatibilität (Outlook, GMail etc.).
 *
 * Farben (Single Source of Truth: docs/design-system.md):
 *   #114884 primary       Texte, Akzente
 *   #1D4281 primary-dark  Sub-Headlines
 *   #587EA8 mid-blue      Hint-Text
 *   #D6E1EE soft-blue     Borders
 *   #1A2533 ink           Body
 *   #FAFBFC paper         Page-Background
 *   #1E8449 success       Guthaben
 *   #A93226 danger        Schulden
 *   #F4F2EC paper-soft    Zahlungsplan-Pillen
 */

const SITE_URL = process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://bordkasse.dieter.ms";

export type DebtItem = {
  counterparty_name: string;
  amount: number;
  /** "owes" = du schuldest counterparty, "receives" = counterparty zahlt dir */
  direction: "owes" | "receives";
};

export type SettlementMailParams = {
  recipientName: string;
  tripName: string;
  tripDates: string; // formatted "5.4.2026 – 15.4.2026"
  balance: number;   // Saldo der Person (+ = bekommt, − = zahlt)
  debts: DebtItem[];
  appUrl: string;    // Link zur Bilanz-Seite des Trips
  skipperName: string;
};

const fmtEuro = (n: number) =>
  new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(n);

export function renderSettlementMail(p: SettlementMailParams): { html: string; text: string; subject: string } {
  const subject = `Bordkasse-Abrechnung: ${p.tripName}`;
  const isCreditor = p.balance > 0.005;
  const isDebtor = p.balance < -0.005;
  const balanceColor = isCreditor ? "#1E8449" : isDebtor ? "#A93226" : "#587EA8";
  const balanceText = isCreditor
    ? `Du bekommst noch ${fmtEuro(p.balance)} zurück.`
    : isDebtor
      ? `Du zahlst noch ${fmtEuro(Math.abs(p.balance))}.`
      : `Du bist quitt — nichts mehr zu tun.`;

  const debtsRows = p.debts
    .map((d) => {
      const line = d.direction === "owes"
        ? `Du zahlst <strong>${fmtEuro(d.amount)}</strong> an <strong>${escapeHtml(d.counterparty_name)}</strong>`
        : `<strong>${escapeHtml(d.counterparty_name)}</strong> zahlt dir <strong>${fmtEuro(d.amount)}</strong>`;
      return `
              <tr>
                <td style="padding:10px 14px;background-color:#F4F2EC;border-radius:6px;margin-bottom:6px;font-size:14px;color:#1A2533;">
                  ${line}
                </td>
              </tr>
              <tr><td style="height:6px;line-height:6px;font-size:6px;">&nbsp;</td></tr>`;
    })
    .join("");

  const debtsBlock = p.debts.length === 0
    ? ""
    : `
            <tr>
              <td style="padding:8px 32px 0 32px;">
                <h3 style="margin:0 0 10px 0;font-size:15px;font-weight:600;color:#114884;">
                  Zahlungsplan
                </h3>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  ${debtsRows}
                </table>
              </td>
            </tr>`;

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
      Die Bordkasse für ${escapeHtml(p.tripName)} ist abgerechnet — ${stripHtml(balanceText)}
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
                  Abrechnung steht
                </h2>
                <p style="margin:0 0 12px 0;font-size:15px;line-height:1.55;color:#1A2533;">
                  Hi ${escapeHtml(p.recipientName)},
                </p>
                <p style="margin:0 0 12px 0;font-size:15px;line-height:1.55;color:#1A2533;">
                  ${escapeHtml(p.skipperName)} hat die Bordkasse für unseren Törn final abgerechnet.
                </p>
                <p style="margin:0;font-size:16px;line-height:1.5;color:${balanceColor};font-weight:600;">
                  ${escapeHtml(balanceText)}
                </p>
              </td>
            </tr>
${debtsBlock}

            <!-- Button -->
            <tr>
              <td align="center" style="padding:24px 32px 8px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td align="center" style="border-radius:8px;background-color:#114884;">
                      <a href="${p.appUrl}"
                         style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px;">
                        Bilanz in der App öffnen
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
                  Tipp: In der App kannst du deine Zahlung als erledigt abhaken — alle in der
                  Crew sehen den Status live. Sollte sich nachträglich etwas an der Bordkasse
                  ändern, bekommst du eine neue Mail.
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

  const text = `Bordkasse-Abrechnung
${p.tripName} · ${p.tripDates}

Hi ${p.recipientName},

${p.skipperName} hat die Bordkasse für unseren Törn final abgerechnet.
${balanceText}
${
  p.debts.length === 0
    ? ""
    : "\nZahlungsplan:\n" +
      p.debts
        .map((d) =>
          d.direction === "owes"
            ? `  • Du zahlst ${fmtEuro(d.amount)} an ${d.counterparty_name}`
            : `  • ${d.counterparty_name} zahlt dir ${fmtEuro(d.amount)}`,
        )
        .join("\n") +
      "\n"
}
Bilanz in der App: ${p.appUrl}

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

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}
