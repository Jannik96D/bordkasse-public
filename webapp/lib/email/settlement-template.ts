/**
 * HTML- und Text-Template für die "Abrechnung-verschickt"-Mail an jedes
 * Crew-Mitglied. Inhalt ist personalisiert auf den eigenen Saldo + die
 * konkreten Zahlungsanweisungen (du-zahlst-an / an-dich-zahlt).
 *
 * Layout über `mail-shell.ts` — identisch zu allen anderen Bordkasse-Mails.
 *
 * Farben (Single Source of Truth: docs/design-system.md):
 *   #114884 primary       Texte, Akzente
 *   #1D4281 primary-dark  Sub-Headlines
 *   #587EA8 mid-blue      Hint-Text
 *   #1A2533 ink           Body
 *   #1E8449 success       Guthaben
 *   #A93226 danger        Schulden
 *   #F4F2EC paper-soft    Zahlungsplan-Pillen
 */

import { renderMailShell, renderActionButton, renderHintBlock, escapeHtml, stripHtml, fmtEuro } from "./mail-shell";

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
  appUrl: string;    // Link zur Schulden-Seite des Trips (zum direkten Abhaken)
  skipperName: string;
  /** Wenn true: Update-Mail-Variante (Wortlaut "Bilanz hat sich aktualisiert"). */
  isUpdate?: boolean;
  /** Optionaler Diff-Hinweis ("3 neue Buchungen, 1 geändert"). Nur bei isUpdate. */
  changeSummary?: string;
};

export function renderSettlementMail(p: SettlementMailParams): { html: string; text: string; subject: string } {
  const subject = p.isUpdate
    ? `Bordkasse-Update: ${p.tripName}`
    : `Bordkasse-Abrechnung: ${p.tripName}`;
  const headline = p.isUpdate ? "Bilanz aktualisiert" : "Abrechnung steht";
  const isCreditor = p.balance > 0.005;
  const isDebtor = p.balance < -0.005;
  const balanceColor = isCreditor ? "#1E8449" : isDebtor ? "#A93226" : "#587EA8";
  const balanceText = isCreditor
    ? `Du bekommst noch ${fmtEuro(p.balance)} zurück.`
    : isDebtor
      ? `Du zahlst noch ${fmtEuro(Math.abs(p.balance))}.`
      : `Du bist quitt — nichts mehr zu tun.`;
  const introText = p.isUpdate
    ? `${p.skipperName} hat Buchungen für unseren Törn aktualisiert — die Bilanz hat sich seit der letzten Mail geändert.`
    : `${p.skipperName} hat die Bordkasse für unseren Törn final abgerechnet.`;
  const changeSummaryBlock = p.isUpdate && p.changeSummary
    ? `
            <tr>
              <td style="padding:0 32px 8px 32px;">
                <p style="margin:0;padding:10px 14px;background-color:#FDF6DC;border-left:3px solid #C8A51E;font-size:13px;color:#1A2533;border-radius:4px;">
                  <strong>Was hat sich geändert:</strong> ${escapeHtml(p.changeSummary)}
                </p>
              </td>
            </tr>`
    : "";

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

  const body = `
            <tr>
              <td style="padding:32px 32px 8px 32px;">
                <h2 style="margin:0 0 12px 0;font-size:18px;font-weight:600;color:#1D4281;">
                  ${escapeHtml(headline)}
                </h2>
                <p style="margin:0 0 12px 0;font-size:15px;line-height:1.55;color:#1A2533;">
                  Hi ${escapeHtml(p.recipientName)},
                </p>
                <p style="margin:0 0 12px 0;font-size:15px;line-height:1.55;color:#1A2533;">
                  ${escapeHtml(introText)}
                </p>
                <p style="margin:0;font-size:16px;line-height:1.5;color:${balanceColor};font-weight:600;">
                  ${escapeHtml(balanceText)}
                </p>
              </td>
            </tr>
${changeSummaryBlock}${debtsBlock}
${renderActionButton(p.appUrl, "Zahlungen in der App abhaken")}
${renderHintBlock(
  "Tipp: In der App kannst du deine Zahlung als erledigt abhaken — alle in der Crew sehen den Status live. Sollte sich nachträglich etwas an der Bordkasse ändern, bekommst du eine neue Mail.",
)}`;

  const html = renderMailShell({
    title: subject,
    preheader: `Die Bordkasse für ${p.tripName} ist abgerechnet — ${stripHtml(balanceText)}`,
    subtitle: `${p.tripName} · ${p.tripDates}`,
    body,
  });

  const text = `${p.isUpdate ? "Bordkasse-Update" : "Bordkasse-Abrechnung"}
${p.tripName} · ${p.tripDates}

Hi ${p.recipientName},

${introText}
${p.isUpdate && p.changeSummary ? `Was hat sich geändert: ${p.changeSummary}\n` : ""}${balanceText}
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
Zahlungen abhaken: ${p.appUrl}

—
Bordkasse · Faire Kostenaufteilung auf Segel-Törns
`;

  return { html, text, subject };
}
