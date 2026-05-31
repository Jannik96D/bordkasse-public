/**
 * HTML- und Text-Template für die Anzahlungs-Erinnerungs-Mail.
 * Layout über `mail-shell.ts` — identisch zu Settlement / Debt-Settled /
 * Payment-Pending (Logo-PNG, „Bordkasse"-Wortmarke, Card auf #FAFBFC).
 *
 * Spec: docs/prepayments.md §Erinnerungsmail
 */

import { renderMailShell, renderActionButton, renderHintBlock, escapeHtml, fmtEuro } from "./mail-shell";

export type ReminderTrancheItem = {
  label: string;
  due_date: string;       // formatiert "15.07.2026"
  amount_due: number;     // verbleibender Restbetrag
  amount_total: number;   // Gesamt-Soll der Person für diese Tranche
};

export type PrepaymentReminderParams = {
  recipientName: string;
  tripName: string;
  tranches: ReminderTrancheItem[];
  weroId?: string | null;
  /** Anzeigename der Person, an die die Crew zahlt (Vorstrecker — Default = Skipper). */
  advancerName: string;
  appUrl: string;
};

export function renderPrepaymentReminderMail(p: PrepaymentReminderParams): {
  html: string;
  text: string;
  subject: string;
} {
  const subject = `Erinnerung Bordkasse-Anzahlung: ${p.tripName}`;
  const totalOpen = p.tranches.reduce((s, t) => s + t.amount_due, 0);

  const trancheRows = p.tranches
    .map(
      (t) => `
                <tr>
                  <td style="padding:10px 14px;background-color:#F4F2EC;border-radius:6px;font-size:14px;color:#1A2533;">
                    <strong>${escapeHtml(t.label)}</strong> &nbsp;
                    <span style="color:#587EA8;">fällig ${escapeHtml(t.due_date)}</span><br/>
                    Offen: <strong>${fmtEuro(t.amount_due)}</strong>${
                      t.amount_total !== t.amount_due ? ` (von ${fmtEuro(t.amount_total)})` : ""
                    }
                  </td>
                </tr>
                <tr><td style="height:6px;line-height:6px;font-size:6px;">&nbsp;</td></tr>`,
    )
    .join("");

  // Wero-Block: dynamischer Hinweis "Bitte schicke {Vorstrecker} per Wero …".
  // Wero stellt aktuell keine öffentliche API für Zahl-Links bereit — daher
  // gibt es keinen Klick-Link, sondern nur die Wero-ID zum manuellen
  // Übernehmen in die Wero-App.
  const weroBlock = p.weroId
    ? `
            <tr>
              <td style="padding:8px 32px 0 32px;">
                <p style="margin:0 0 8px 0;font-size:14px;line-height:1.55;color:#1A2533;">
                  Bitte schicke <strong>${escapeHtml(p.advancerName)}</strong> per Wero die fällige Anzahlung.
                </p>
                <p style="margin:0;padding:10px 14px;background-color:#FDF6DC;border-left:3px solid #C8A51E;font-size:13px;color:#1A2533;border-radius:4px;">
                  <strong>Wero-ID (${escapeHtml(p.advancerName)}):</strong> ${escapeHtml(p.weroId)}<br/>
                  <span style="color:#587EA8;">Verwendungszweck: Anzahlung ${escapeHtml(p.tripName)}</span>
                </p>
              </td>
            </tr>`
    : `
            <tr>
              <td style="padding:8px 32px 0 32px;">
                <p style="margin:0;padding:10px 14px;background-color:#FDF6DC;border-left:3px solid #C8A51E;font-size:13px;color:#1A2533;border-radius:4px;">
                  Frag <strong>${escapeHtml(p.advancerName)}</strong> nach den Überweisungsdetails — es ist keine Wero-ID hinterlegt.
                </p>
              </td>
            </tr>`;

  const body = `
            <tr>
              <td style="padding:32px 32px 8px 32px;">
                <h2 style="margin:0 0 12px 0;font-size:18px;font-weight:600;color:#1D4281;">
                  Erinnerung: Anzahlung
                </h2>
                <p style="margin:0 0 12px 0;font-size:15px;line-height:1.55;color:#1A2533;">
                  Hi ${escapeHtml(p.recipientName)},
                </p>
                <p style="margin:0;font-size:15px;line-height:1.55;color:#1A2533;">
                  hier deine offenen Anzahlungs-Tranchen für den Törn
                  <strong>${escapeHtml(p.tripName)}</strong>.
                  Insgesamt offen: <strong>${fmtEuro(totalOpen)}</strong>.
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:18px 32px 0 32px;">
                <h3 style="margin:0 0 10px 0;font-size:15px;font-weight:600;color:#114884;">
                  Offene Tranchen
                </h3>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  ${trancheRows}
                </table>
              </td>
            </tr>
${weroBlock}
${renderActionButton(p.appUrl, "In der Bordkasse anzeigen")}
${renderHintBlock(
  "Wero bietet aktuell keine öffentliche Schnittstelle für Klick-Links. Bitte die Wero-ID in deiner Wero-App als Empfänger eingeben und Betrag + Verwendungszweck manuell übernehmen.",
)}`;

  const html = renderMailShell({
    title: subject,
    preheader: `Offene Anzahlung: ${fmtEuro(totalOpen)} für ${p.tripName}`,
    subtitle: p.tripName,
    body,
  });

  const trancheText = p.tranches
    .map(
      (t) => `  - ${t.label} (fällig ${t.due_date}): offen ${fmtEuro(t.amount_due)}`,
    )
    .join("\n");

  const weroText = p.weroId
    ? `Bitte schicke ${p.advancerName} per Wero die fällige Anzahlung.
Wero-ID (${p.advancerName}): ${p.weroId}
Verwendungszweck: Anzahlung ${p.tripName}
(Wero bietet keine Klick-Links — bitte Wero-ID in deiner Wero-App als Empfänger eingeben und Betrag/Verwendungszweck manuell kopieren.)`
    : `Frag ${p.advancerName} nach den Überweisungsdetails — es ist keine Wero-ID hinterlegt.`;

  const text = `Erinnerung: Anzahlung
${p.tripName}

Hi ${p.recipientName},

hier deine offenen Anzahlungs-Tranchen für den Törn ${p.tripName}.

Offene Tranchen:
${trancheText}

Gesamt offen: ${fmtEuro(totalOpen)}

${weroText}

In der App: ${p.appUrl}

—
Bordkasse · Faire Kostenaufteilung auf Segeltörns
`;

  return { html, text, subject };
}
