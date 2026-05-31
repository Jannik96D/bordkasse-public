/**
 * Mail an den Vorstrecker — Erinnerung an die ANSTEHENDE eigene Überweisung
 * an die Charteragentur. Wird ausgelöst entweder vom Cron (3 Tage vor
 * Charter-Fälligkeit) oder manuell vom 🔔-Button in seiner Matrix-Zeile.
 *
 * Per Tranche zeigen wir:
 *   - Soll (Charteragentur)         = totalAmount × percent / 100
 *   - Crew-Beiträge bei mir         = was die Crew bisher gezahlt hat
 *   - Bereits an Agentur überwiesen = expense-Buchung mit dieser Tranche
 *   - Noch offen                    = soll − bereits überwiesen
 *
 * Layout über `mail-shell.ts`.
 */

import { renderMailShell, renderActionButton, renderHintBlock, escapeHtml, fmtEuro } from "./mail-shell";

export type CharterReminderTranche = {
  label: string;
  charter_due_date: string;        // formatiert "15.07.2026"
  soll_to_agency: number;          // Soll der Agentur (für diese Tranche)
  crew_paid_to_advancer: number;   // Σ Crew-Beiträge bei dir
  crew_total_due: number;          // Σ Crew-Soll (zum Vergleich)
  paid_to_agency: number;          // schon an Agentur überwiesen
  remaining_to_agency: number;     // noch offen
};

export type CharterReminderParams = {
  recipientName: string;           // = Vorstrecker
  tripName: string;
  tranches: CharterReminderTranche[];
  appUrl: string;
  /** true = ausgelöst vom Cron (3 Tage vor Frist); false = manuell. */
  isAutomated?: boolean;
};

export function renderCharterReminderMail(p: CharterReminderParams): {
  html: string;
  text: string;
  subject: string;
} {
  const totalRemaining = p.tranches.reduce((s, t) => s + Math.max(0, t.remaining_to_agency), 0);
  const subject = p.isAutomated
    ? `Charteranzahlung fällig: ${p.tripName}`
    : `Charteranzahlung – Übersicht: ${p.tripName}`;
  const headline = p.isAutomated ? "Charteranzahlung steht an" : "Charteranzahlung – Übersicht";
  const introText = p.isAutomated
    ? `in den nächsten Tagen wird deine Anzahlung an die Charteragentur fällig. Hier eine Übersicht, was bei dir ankommt und was du noch überweisen musst.`
    : `hier dein aktueller Stand für die Anzahlung an die Charteragentur: was bei dir ankommt und was du noch überweisen musst.`;

  const trancheRows = p.tranches
    .map((t) => {
      // „Überfällig" nur wenn das Datum strikt in der Vergangenheit liegt —
      // am Stichtag selbst zählt es noch nicht als verpasst.
      const overdueBadge =
        t.remaining_to_agency > 0.005 && isDueInPast(t.charter_due_date)
          ? `<span style="display:inline-block;margin-left:6px;padding:1px 6px;background-color:#A93226;color:#FFFFFF;border-radius:3px;font-size:10px;font-weight:600;text-transform:uppercase;">Überfällig</span>`
          : "";
      return `
                <tr>
                  <td style="padding:14px;background-color:#F4F2EC;border-radius:6px;font-size:14px;color:#1A2533;">
                    <div style="margin-bottom:4px;">
                      <strong>${escapeHtml(t.label)}</strong>
                      ${overdueBadge}
                      <span style="color:#587EA8;"> · Charterfrist ${escapeHtml(t.charter_due_date)}</span>
                    </div>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:6px;font-size:13px;">
                      <tr>
                        <td style="padding:2px 0;color:#587EA8;">Soll Agentur:</td>
                        <td style="padding:2px 0;text-align:right;font-weight:600;">${fmtEuro(t.soll_to_agency)}</td>
                      </tr>
                      <tr>
                        <td style="padding:2px 0;color:#587EA8;">Crew bei dir eingegangen:</td>
                        <td style="padding:2px 0;text-align:right;">${fmtEuro(t.crew_paid_to_advancer)} <span style="color:#587EA8;">von ${fmtEuro(t.crew_total_due)}</span></td>
                      </tr>
                      <tr>
                        <td style="padding:2px 0;color:#587EA8;">An Agentur überwiesen:</td>
                        <td style="padding:2px 0;text-align:right;">${fmtEuro(t.paid_to_agency)}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0 0 0;color:#1A2533;font-weight:600;">Noch zu überweisen:</td>
                        <td style="padding:6px 0 0 0;text-align:right;font-weight:700;color:${t.remaining_to_agency > 0.005 ? "#A93226" : "#1E8449"};">
                          ${fmtEuro(Math.max(0, t.remaining_to_agency))}
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr><td style="height:8px;line-height:8px;font-size:8px;">&nbsp;</td></tr>`;
    })
    .join("");

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
                <p style="margin:0;font-size:16px;line-height:1.5;color:${totalRemaining > 0.005 ? "#A93226" : "#1E8449"};font-weight:600;">
                  ${totalRemaining > 0.005
                    ? `Insgesamt noch zu überweisen: ${fmtEuro(totalRemaining)}`
                    : "Alle Charteranzahlungen sind vollständig überwiesen."}
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:18px 32px 0 32px;">
                <h3 style="margin:0 0 10px 0;font-size:15px;font-weight:600;color:#114884;">
                  Tranchen
                </h3>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  ${trancheRows}
                </table>
              </td>
            </tr>
${renderActionButton(p.appUrl, "In der Bordkasse ansehen")}
${renderHintBlock(
  "Sobald du an die Agentur überwiesen hast, erfasse die Überweisung als neue Ausgabe und ordne sie der passenden Tranche zu, sie taucht dann hier korrekt an.",
)}`;

  const html = renderMailShell({
    title: subject,
    preheader: totalRemaining > 0.005
      ? `Noch ${fmtEuro(totalRemaining)} an die Charteragentur überweisen — ${p.tripName}`
      : `Alle Charteranzahlungen für ${p.tripName} sind vollständig überwiesen.`,
    subtitle: p.tripName,
    body,
  });

  const trancheText = p.tranches
    .map(
      (t) =>
        `  - ${t.label} (Charterfrist ${t.charter_due_date}):
      Soll Agentur:      ${fmtEuro(t.soll_to_agency)}
      Crew bei dir:      ${fmtEuro(t.crew_paid_to_advancer)} von ${fmtEuro(t.crew_total_due)}
      An Agentur:        ${fmtEuro(t.paid_to_agency)}
      NOCH ZU ÜBERWEISEN: ${fmtEuro(Math.max(0, t.remaining_to_agency))}`,
    )
    .join("\n\n");

  const text = `${headline}
${p.tripName}

Hi ${p.recipientName},

${introText}

${totalRemaining > 0.005
    ? `Insgesamt noch zu überweisen: ${fmtEuro(totalRemaining)}`
    : "Alle Charteranzahlungen sind vollständig überwiesen."}

Tranchen:
${trancheText}

In der App: ${p.appUrl}

—
Bordkasse · Faire Kostenaufteilung auf Segeltörns
`;

  return { html, text, subject };
}

/** True wenn das formatierte Datum „d.m.yyyy" strikt vor heute liegt. */
function isDueInPast(dueDate: string): boolean {
  if (!dueDate) return false;
  const parts = dueDate.split(".");
  if (parts.length !== 3) return false;
  const [dStr, mStr, yStr] = parts;
  const due = new Date(`${yStr}-${mStr.padStart(2, "0")}-${dStr.padStart(2, "0")}T00:00:00Z`);
  if (Number.isNaN(due.getTime())) return false;
  const nowIso = new Date().toISOString().slice(0, 10);
  const now = new Date(`${nowIso}T00:00:00Z`);
  return due.getTime() < now.getTime();
}
