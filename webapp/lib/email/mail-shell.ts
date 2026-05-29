/**
 * Gemeinsamer HTML-Wrapper für alle Bordkasse-Mails.
 *
 * Alle Mail-Templates (settlement, debt-settled, prepayment-reminder,
 * payment-pending) sollen identisch aussehen: Logo-PNG oben, „Bordkasse"-
 * Wortmarke, optionale Subline (Törn · Datum), Card auf #FAFBFC, Footer mit
 * Datenschutz-Link.
 *
 * Inhalte je Template stecken im `body`-Parameter und werden roh in die
 * Card eingefügt (als <tr>-Reihen).
 *
 * Farben (Single Source of Truth: docs/design-system.md):
 *   #114884 primary       Texte, Akzente
 *   #1D4281 primary-dark  Sub-Headlines
 *   #587EA8 mid-blue      Hint-Text
 *   #D6E1EE soft-blue     Borders
 *   #1A2533 ink           Body
 *   #FAFBFC paper         Page-Background
 *   #F4F2EC paper-soft    Detail-Pillen
 *   #7A8DA1 footer        Footer-Text
 */

const SITE_URL = process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://bordkasse.dieter.ms";

export interface MailShellParams {
  /** Doc-Title (Browser-Tab im Webmailer) und im preheader. */
  title: string;
  /** Versteckter Vorschautext, den Mail-Clients als Snippet zeigen. */
  preheader: string;
  /** Optionale Subline unter „Bordkasse" (z. B. „Törnname · 5.4.2026 – 15.4.2026"). */
  subtitle?: string;
  /** Roher Inhalt zwischen Logo-Header und Footer (eine oder mehrere `<tr>`-Reihen). */
  body: string;
}

export function renderMailShell(p: MailShellParams): string {
  const subtitleRow = p.subtitle
    ? `
            <tr>
              <td align="center" style="padding:4px 24px 0 24px;">
                <p style="margin:0;font-size:14px;color:#587EA8;">
                  ${escapeHtml(p.subtitle)}
                </p>
              </td>
            </tr>`
    : "";

  return `<!DOCTYPE html>
<html lang="de">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>${escapeHtml(p.title)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#FAFBFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1A2533;">
    <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">
      ${escapeHtml(p.preheader)}
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
            </tr>${subtitleRow}

${p.body}
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
}

/**
 * Standard-Button (Primärfarbe) plus Fallback-Link darunter. Wird in fast
 * jedem Template verwendet, also als Helper gebündelt.
 */
export function renderActionButton(href: string, label: string): string {
  return `
            <!-- Button -->
            <tr>
              <td align="center" style="padding:24px 32px 8px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td align="center" style="border-radius:8px;background-color:#114884;">
                      <a href="${href}"
                         style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px;">
                        ${escapeHtml(label)}
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
                  <a href="${href}" style="color:#114884;text-decoration:underline;">${escapeHtml(href)}</a>
                </p>
              </td>
            </tr>`;
}

/** Trenner + Hinweistext am Ende der Card. */
export function renderHintBlock(hint: string): string {
  return `
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
                  ${escapeHtml(hint)}
                </p>
              </td>
            </tr>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" :
    ch === "<" ? "&lt;" :
    ch === ">" ? "&gt;" :
    ch === '"' ? "&quot;" : "&#39;",
  );
}

export function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

/** Einheitliches EUR-Format für alle Mail-Templates. */
export function fmtEuro(n: number): string {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}
