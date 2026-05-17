/**
 * HTML- und Text-Template für die "Abrechnung-verschickt"-Mail an jedes
 * Crew-Mitglied. Inhalt ist personalisiert auf den eigenen Saldo + die
 * konkreten Zahlungsanweisungen (du-zahlst-an / an-dich-zahlt).
 *
 * Bewusst inline-styled (kein Tailwind im Mail-Renderer) — Mail-Clients
 * unterstützen kein modernes CSS. Farben aus dem Bordkasse-Design.
 */

const PRIMARY = "#114884";
const INK_SOFT = "#5a6b7c";
const SUCCESS = "#1E8449";
const DANGER = "#A93226";
const PAPER_SOFT = "#F4F2EC";

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
  const balanceLabel = isCreditor
    ? `Du bekommst noch <strong style="color:${SUCCESS}">${fmtEuro(p.balance)}</strong> zurück.`
    : isDebtor
      ? `Du zahlst noch <strong style="color:${DANGER}">${fmtEuro(Math.abs(p.balance))}</strong>.`
      : `Du bist quitt — nichts mehr zu tun.`;

  const debtsHtml = p.debts.length === 0
    ? ""
    : `
      <h3 style="margin:20px 0 8px;color:${PRIMARY};font-size:15px">Zahlungsplan</h3>
      <ul style="padding:0;margin:0;list-style:none">
        ${p.debts.map((d) =>
          d.direction === "owes"
            ? `<li style="padding:8px 12px;margin:0 0 6px;background:${PAPER_SOFT};border-radius:6px">
                Du zahlst <strong>${fmtEuro(d.amount)}</strong> an <strong>${escapeHtml(d.counterparty_name)}</strong>
              </li>`
            : `<li style="padding:8px 12px;margin:0 0 6px;background:${PAPER_SOFT};border-radius:6px">
                <strong>${escapeHtml(d.counterparty_name)}</strong> zahlt dir <strong>${fmtEuro(d.amount)}</strong>
              </li>`,
        ).join("")}
      </ul>`;

  const html = `<!doctype html>
<html lang="de">
<body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#fff;color:#222">
  <div style="max-width:520px;margin:0 auto">
    <h1 style="color:${PRIMARY};font-size:22px;margin:0 0 4px">Abrechnung steht</h1>
    <p style="color:${INK_SOFT};margin:0 0 16px">${escapeHtml(p.tripName)} · ${escapeHtml(p.tripDates)}</p>

    <p>Hi ${escapeHtml(p.recipientName)},</p>
    <p>${escapeHtml(p.skipperName)} hat die Bordkasse für unseren Törn final abgerechnet. ${balanceLabel}</p>

    ${debtsHtml}

    <p style="margin:24px 0">
      <a href="${p.appUrl}"
         style="display:inline-block;background:${PRIMARY};color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">
        Bilanz in der Bordkasse öffnen
      </a>
    </p>

    <p style="font-size:13px;color:${INK_SOFT};border-top:1px solid #e0d8c8;padding-top:12px;margin-top:24px">
      Tipp: In der App kannst du erledigte Zahlungen abhaken — alle in der Crew sehen
      den Status live.
    </p>
  </div>
</body>
</html>`;

  const text = `Abrechnung steht
${p.tripName} · ${p.tripDates}

Hi ${p.recipientName},

${p.skipperName} hat die Bordkasse für unseren Törn final abgerechnet. ${stripHtml(balanceLabel)}
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
        .join("\n")
}

Bilanz in der App: ${p.appUrl}
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
