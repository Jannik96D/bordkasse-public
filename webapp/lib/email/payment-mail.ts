/**
 * Gemeinsames Gerüst für ALLE Zahlungs-Mails (Anzahlungsplan + weitere
 * Zahlungen; PR7 „Weitere Zahlungen").
 *
 * Intern heißen weitere Zahlungen `item` (Tabelle `prepayment_items`); für
 * Nutzer gibt es das Wort „Posten" nicht mehr. Mails und Pushs nennen die
 * Sache beim Label („Flüge: dein Anteil 180,00 € bis 12.10."), das Hauptwort
 * „Weitere Zahlung(en)" kommt nur in Navigation/Überschriften der App vor.
 *
 * Drei Mail-Arten, ein Aufbau (Kopf · Fakten-Karte · „So geht's" · Button ·
 * Hinweis) und eine Betreff-Konvention:
 *
 *   Anteil-Mail (Crew):          „{Was}: dein Anteil {Betrag} bis {Datum}"
 *   Vorstreck-Mail:              „{Was}: du streckst {Betrag} vor – bis {Datum}"
 *   Ereignis-Mail:               „{Was}: {Betrag} von {Name} {Status}"
 *   Änderung:                    Präfix „Geändert: ", Erinnerung: „Erinnerung: "
 *   Ohne Datum:                  „… – Frist folgt"
 *
 * Fakten-Karte der Anteil-Mail: „Dein Anteil" · „Bis wann" · „An wen"; der
 * Zahlungsweg steht im Block „So geht's". Status-Wörter überall gleich:
 * „gemeldet – wartet auf Bestätigung", „bestätigt", „abgelehnt".
 *
 * WERO-REGEL: ohne Wero-ID (null/leer/Whitespace) erwähnt keine Mail Wero.
 *
 * ⚠️ Escaping: Bezeichnungen, Namen, Törnname, Notiz, Wero-ID sind frei
 * editierbar → im HTML IMMER escapeHtml (die Fakten tragen `html` und `text`
 * getrennt; `html` MUSS der Aufrufer escapen, `text` bleibt roh).
 */

import { renderMailShell, renderActionButton, renderHintBlock, escapeHtml, fmtEuro } from "./mail-shell";
import { normalizeWeroId } from "@/lib/prepayments/notify";
import { NO_DUE_TEXT, PAYMENT_STATUS, cleanLine } from "@/lib/prepayments/payment-words";

/** CTA-Text aller Zahlungs-Mails. */
export const PAYMENT_CTA = "Zahlungen öffnen";
export const MAIL_FOOTER_TEXT = "—\nBordkasse · Faire Kostenaufteilung auf Segeltörns\n";
export { NO_DUE_TEXT, PAYMENT_STATUS };

export type TripType = "sailing" | "other";
export const tripPhrase = (t: TripType) => (t === "other" ? "die Reise" : "den Törn");

// ── Betreffzeilen ──────────────────────────────────────────────────────────

function dueTail(due: string | null | undefined, overdueSince?: string): string {
  if (overdueSince) return ` – überfällig seit ${cleanLine(overdueSince, 20)}`;
  return due ? ` bis ${cleanLine(due, 20)}` : ` – ${NO_DUE_TEXT}`;
}

function subjectPrefix(args: { isUpdate?: boolean; isReminder?: boolean }): string {
  if (args.isUpdate) return "Geändert: ";
  if (args.isReminder) return "Erinnerung: ";
  return "";
}

/** „{Was}: dein Anteil {Betrag} bis {Datum}" (Crew). */
export function shareSubject(args: {
  what: string;
  amount: number;
  due: string | null | undefined;
  isUpdate?: boolean;
  isReminder?: boolean;
  /** Frist beim Anbieter schon verstrichen (nur manuelle Erinnerung) — ersetzt „bis {Datum}". */
  overdueSince?: string;
}): string {
  return `${subjectPrefix(args)}${cleanLine(args.what)}: dein Anteil ${fmtEuro(args.amount)}${dueTail(args.due, args.overdueSince)}`;
}

/** „{Was}: du streckst {Betrag} vor – bis {Datum}" (vorstreckende Person). */
export function advanceSubject(args: {
  what: string;
  amount: number;
  due: string | null | undefined;
  isUpdate?: boolean;
  isReminder?: boolean;
  overdueSince?: string;
}): string {
  const tail = args.overdueSince ? ` – überfällig seit ${cleanLine(args.overdueSince, 20)}` : args.due ? ` – bis ${cleanLine(args.due, 20)}` : ` – ${NO_DUE_TEXT}`;
  return `${subjectPrefix(args)}${cleanLine(args.what)}: du streckst ${fmtEuro(args.amount)} vor${tail}`;
}

export type PaymentEventKind = "pending" | "recorded" | "confirmed" | "rejected";

export const EVENT_WORD: Record<PaymentEventKind, string> = {
  pending: PAYMENT_STATUS.pending,
  recorded: "Einzahlung erfasst",
  confirmed: PAYMENT_STATUS.confirmed,
  rejected: PAYMENT_STATUS.rejected,
};

/** „{Was}: {Betrag} von {Name} {Status}" (Ereignis-Mails). */
export function eventSubject(args: { what: string; kind: PaymentEventKind; who: string; amount: number }): string {
  return `${cleanLine(args.what)}: ${fmtEuro(args.amount)} von ${cleanLine(args.who, 40)} – ${EVENT_WORD[args.kind]}`;
}

// ── Bausteine ──────────────────────────────────────────────────────────────

export interface Fact {
  label: string;
  /** Bereits escapter HTML-Wert (darf <br/> enthalten). */
  html: string;
  /** Roher Text-Wert (mehrzeilig erlaubt → Label steht dann allein in der Zeile). */
  text: string;
  /** Wert hervorheben (fett). */
  strong?: boolean;
  /** Farbe des Werts (z. B. Rot für „noch offen"). */
  color?: string;
}

export interface Block {
  html: string;
  text: string;
}

const PILL = "background-color:#FDF6DC;border-left:3px solid #C8A51E;font-size:13px;color:#1A2533;border-radius:4px;";

/** Überschrift + Anrede + Einleitung (immer „Hi {Name},"). */
export function mailHead(headline: string, recipientName: string, introHtml: string): string {
  return `
            <tr>
              <td style="padding:32px 32px 8px 32px;">
                <h2 style="margin:0 0 12px 0;font-size:18px;font-weight:600;color:#1D4281;">
                  ${escapeHtml(headline)}
                </h2>
                <p style="margin:0 0 12px 0;font-size:15px;line-height:1.55;color:#1A2533;">
                  Hi ${escapeHtml(recipientName)},
                </p>
                <p style="margin:0;font-size:15px;line-height:1.55;color:#1A2533;">
                  ${introHtml}
                </p>
              </td>
            </tr>`;
}

/** Fakten-Karte: Label links, Wert rechts. Optional farbiger linker Rand (Ereignis-Mails). */
export function factsCard(facts: Fact[], accent?: string): Block {
  const rows = facts
    .map((f) => {
      const style = `padding:3px 0;text-align:right;${f.strong ? "font-weight:700;" : ""}${f.color ? `color:${f.color};` : "color:#1A2533;"}`;
      return `
                        <tr>
                          <td style="padding:3px 12px 3px 0;color:#587EA8;vertical-align:top;white-space:nowrap;">${escapeHtml(f.label)}</td>
                          <td style="${style}vertical-align:top;">${f.html}</td>
                        </tr>`;
    })
    .join("");
  const html = `
            <tr>
              <td style="padding:18px 32px 0 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding:14px;background-color:#F4F2EC;${accent ? `border-left:3px solid ${accent};` : ""}border-radius:6px;font-size:14px;color:#1A2533;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:14px;">${rows}
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`;
  const text = facts
    .map((f) => (f.text.includes("\n") ? `${f.label}:\n${f.text}` : `${f.label}: ${f.text}`))
    .join("\n");
  return { html, text };
}

/** Zeilen „Name · Betrag" als Mini-Tabelle (Soll je Person). */
export function personTable(rows: { name: string; amount: number }[]): Block {
  const html = rows
    .map(
      (r) => `
                        <tr>
                          <td style="padding:2px 0;color:#1A2533;">${escapeHtml(r.name)}</td>
                          <td style="padding:2px 0;text-align:right;">${fmtEuro(r.amount)}</td>
                        </tr>`,
    )
    .join("");
  const text = rows.map((r) => `  - ${r.name}: ${fmtEuro(r.amount)}`).join("\n");
  return { html, text };
}

/** Zusatzkarte mit Überschrift und Tabelle (z. B. „Soll je Person"). */
export function titledTableCard(title: string, table: Block, footnote?: string): Block {
  const html = `
            <tr>
              <td style="padding:12px 32px 0 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding:14px;background-color:#F4F2EC;border-radius:6px;font-size:14px;color:#1A2533;">
                      <strong>${escapeHtml(title)}</strong>
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:6px;font-size:13px;">${table.html}
                      </table>
                      ${footnote ? `<p style="margin:8px 0 0 0;font-size:13px;color:#587EA8;">${escapeHtml(footnote)}</p>` : ""}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`;
  const text = `${title}:\n${table.text}${footnote ? `\n${footnote}` : ""}`;
  return { html, text };
}

/** Gelber Hinweiskasten (Notiz, Warnung). */
export function noteCard(html: string, text: string): Block {
  return {
    html: `
            <tr>
              <td style="padding:12px 32px 0 32px;">
                <p style="margin:0;padding:10px 14px;${PILL}">
                  ${html}
                </p>
              </td>
            </tr>`,
    text,
  };
}

/**
 * „So geht's": wohin und wie überweisen. Mit Wero-ID: Wero-ID + Verwendungszweck;
 * ohne (null/leer/Whitespace): neutraler Hinweis OHNE jede Wero-Erwähnung.
 */
export function howToPayBlock(args: { payeeName: string; weroId: string | null | undefined; purpose: string }): Block {
  const n = escapeHtml(args.payeeName);
  const weroId = normalizeWeroId(args.weroId);
  if (weroId) {
    return {
      html: `
            <tr>
              <td style="padding:16px 32px 0 32px;">
                <p style="margin:0 0 6px 0;font-size:14px;font-weight:600;color:#114884;">So geht's</p>
                <p style="margin:0 0 8px 0;font-size:14px;line-height:1.55;color:#1A2533;">
                  Bitte schicke <strong>${n}</strong> deinen Anteil per Wero.
                </p>
                <p style="margin:0;padding:10px 14px;${PILL}">
                  <strong>Wero-ID (${n}):</strong> ${escapeHtml(weroId)}<br/>
                  <span style="color:#587EA8;">Verwendungszweck: ${escapeHtml(args.purpose)}</span>
                </p>
              </td>
            </tr>`,
      text: `So geht's:
Bitte schicke ${args.payeeName} deinen Anteil per Wero.
Wero-ID (${args.payeeName}): ${weroId}
Verwendungszweck: ${args.purpose}`,
    };
  }
  return {
    html: `
            <tr>
              <td style="padding:16px 32px 0 32px;">
                <p style="margin:0 0 6px 0;font-size:14px;font-weight:600;color:#114884;">So geht's</p>
                <p style="margin:0;padding:10px 14px;${PILL}">
                  Bitte überweise deinen Anteil an <strong>${n}</strong> — frag ${n} nach den Zahlungsdetails.<br/>
                  <span style="color:#587EA8;">Verwendungszweck: ${escapeHtml(args.purpose)}</span>
                </p>
              </td>
            </tr>`,
    text: `So geht's:
Bitte überweise deinen Anteil an ${args.payeeName} — frag ${args.payeeName} nach den Zahlungsdetails.
Verwendungszweck: ${args.purpose}`,
  };
}

/** „So geht's" für Texte ohne Zahlungsdetails (vorstreckende Person, Ereignis-Mails). */
export function howToBlock(textRaw: string): Block {
  return {
    html: `
            <tr>
              <td style="padding:16px 32px 0 32px;">
                <p style="margin:0 0 6px 0;font-size:14px;font-weight:600;color:#114884;">So geht's</p>
                <p style="margin:0;font-size:14px;line-height:1.55;color:#1A2533;">
                  ${escapeHtml(textRaw)}
                </p>
              </td>
            </tr>`,
    text: `So geht's:\n${textRaw}`,
  };
}

// ── Der eine Renderer ──────────────────────────────────────────────────────

export interface PaymentMailSpec {
  subject: string;
  headline: string;
  recipientName: string;
  tripName: string;
  introHtml: string;
  introText: string;
  preheader: string;
  appUrl: string;
  /** Fakten-Karte (Pflicht). */
  facts: Fact[];
  /** Farbiger Rand der Fakten-Karte. */
  accent?: string;
  /** Weitere Karten/Blöcke zwischen Fakten und „So geht's". */
  extra?: Block[];
  /** „So geht's" (howToPayBlock/howToBlock) oder null. */
  how?: Block | null;
  /** Dezenter Hinweis unter dem Button. */
  hint?: string | null;
}

export function renderPaymentMail(s: PaymentMailSpec): { html: string; text: string; subject: string } {
  const card = factsCard(s.facts, s.accent);
  const extra = s.extra ?? [];
  const how = s.how ?? null;
  const body = `${mailHead(s.headline, s.recipientName, s.introHtml)}
${card.html}
${extra.map((b) => b.html).join("\n")}
${how ? how.html : ""}
${renderActionButton(s.appUrl, PAYMENT_CTA)}
${s.hint ? renderHintBlock(s.hint) : ""}`;

  const html = renderMailShell({ title: s.subject, preheader: s.preheader, subtitle: s.tripName, body });

  const text = `${s.headline}
${s.tripName}

Hi ${s.recipientName},

${s.introText}

${card.text}
${extra.map((b) => `\n${b.text}`).join("")}${how ? `\n\n${how.text}` : ""}${s.hint ? `\n\n${s.hint}` : ""}

${PAYMENT_CTA}: ${s.appUrl}

${MAIL_FOOTER_TEXT}`;

  return { html, text, subject: s.subject };
}
