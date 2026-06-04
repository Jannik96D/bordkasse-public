/**
 * Neutraler Info-Mail-Wortlaut für Skipper / Vorstrecker, wenn eine DRITTE
 * Person (z. B. Admin) eine Schuld zwischen zwei anderen Crewmitgliedern
 * abgehakt hat. Skipper/Vorstrecker bekommen damit Bescheid, ohne dass die
 * normale debt-settled-Mail sie irreführend als „Schuldner" / „Gläubiger"
 * adressiert.
 *
 * Layout via `mail-shell.ts` — identisch zu allen anderen Bordkasse-Mails.
 */

import { renderMailShell, renderActionButton, renderHintBlock, escapeHtml, fmtEuro } from "./mail-shell";
import { tripVocab } from "@/lib/trip-vocab";

export type DebtObserverMailParams = {
  recipientName: string;
  /**
   * Warum bekommt diese Person die Info-Mail? Bestimmt den Hinweis-Text, damit
   * immer nur die zutreffende Rolle genannt wird (bei Personalunion „skipper").
   */
  recipientReason: "skipper" | "advancer";
  actorName: string;
  debtorName: string;
  creditorName: string;
  amount: number;
  tripName: string;
  tripDates: string;
  appUrl: string;
  /** Reise-Typ — steuert das Vokabular (Bordkasse/Törn/Skipper vs. Urlaubskasse/Reise/Reiseleitung). */
  tripType: "sailing" | "other";
};

export function renderDebtObserverMail(p: DebtObserverMailParams): {
  html: string;
  text: string;
  subject: string;
} {
  const vocab = tripVocab(p.tripType);
  const amount = fmtEuro(p.amount);
  const subject = `Schuld abgehakt: ${p.debtorName} → ${p.creditorName} (${p.tripName})`;
  const detailLine = `${p.debtorName} → ${p.creditorName} · ${amount}`;
  const introText = `${p.actorName} hat soeben in der ${vocab.kitty} markiert, dass die Zahlung von ${p.debtorName} in Höhe von ${amount} an ${p.creditorName} erledigt ist.`;
  const reasonText =
    p.recipientReason === "advancer"
      ? `Du bekommst diese Info-Mail, weil du die ${vocab.prepayment} für ${p.tripType === "other" ? "diese Reise" : "diesen Törn"} vorstreckst.`
      : `Du bekommst diese Info-Mail, weil du ${p.tripType === "other" ? "Reiseleitung dieser Reise" : "Skipper dieses Törns"} bist.`;

  const body = `
            <tr>
              <td style="padding:32px 32px 8px 32px;">
                <h2 style="margin:0 0 12px 0;font-size:18px;font-weight:600;color:#1D4281;">
                  Schuld in ${p.tripType === "other" ? "deiner Reise" : "deinem Törn"} abgehakt
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
                      <span style="color:#1E8449;font-weight:600;">${escapeHtml(amount)}</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
${renderActionButton(p.appUrl, "Schulden in der App ansehen")}
${renderHintBlock(
  `${reasonText} Falls etwas nicht stimmt, kann das Häkchen in der App wieder entfernt werden.`,
)}`;

  const html = renderMailShell({
    title: subject,
    preheader: `${detailLine} — ${p.tripName}`,
    subtitle: `${p.tripName} · ${p.tripDates}`,
    body,
  });

  const text = `Schuld in ${p.tripType === "other" ? "deiner Reise" : "deinem Törn"} abgehakt
${p.tripName} · ${p.tripDates}

Hi ${p.recipientName},

${introText}

  ${detailLine}

${reasonText} Falls etwas nicht stimmt, kann das Häkchen in der App wieder entfernt werden.

Schulden in der App: ${p.appUrl}

—
Bordkasse · Faire Kostenaufteilung auf Segeltörns
`;

  return { html, text, subject };
}
