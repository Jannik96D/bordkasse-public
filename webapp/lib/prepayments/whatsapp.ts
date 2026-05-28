/**
 * Render-Helper für WhatsApp-Texte zur Anzahlungs-Erinnerung.
 *
 * Skipper-editierbare Vorlage steht in prepayment_plan.whatsapp_template;
 * fehlt sie, nehmen wir DEFAULT_TEMPLATE.
 *
 * Platzhalter:
 *   {{name}}            Empfänger-Display-Name
 *   {{tranche_label}}   Label der ersten offenen Tranche
 *   {{trip_name}}       Trip-Name
 *   {{amount}}          offener Betrag in €
 *   {{due_date}}        Fälligkeitsdatum, deutsch formatiert
 *   {{wero_link_or_id}} Wero-Request-Link oder Wero-ID, je nachdem was gesetzt
 */

export const DEFAULT_WHATSAPP_TEMPLATE = `Hi {{name}}, kurze Erinnerung an die {{tranche_label}}
für unseren Törn {{trip_name}}:

  Betrag: {{amount}} €
  Fällig: {{due_date}}
  Wero:   {{wero_link_or_id}}
  Verwendungszweck: Anzahlung {{trip_name}} {{tranche_label}}

Danke! 🙏 ⛵`;

export interface WhatsAppRenderInput {
  template?: string | null;
  name: string;
  trancheLabel: string;
  tripName: string;
  amount: number;
  dueDate: string;        // ISO YYYY-MM-DD
  weroLink?: string | null;
  weroId?: string | null;
}

export function renderWhatsAppText(input: WhatsAppRenderInput): string {
  const tmpl = input.template?.trim() || DEFAULT_WHATSAPP_TEMPLATE;
  const wero = input.weroLink || input.weroId || "—";
  const amount = input.amount.toFixed(2).replace(".", ",");
  return tmpl
    .replaceAll("{{name}}", input.name)
    .replaceAll("{{tranche_label}}", input.trancheLabel)
    .replaceAll("{{trip_name}}", input.tripName)
    .replaceAll("{{amount}}", amount)
    .replaceAll("{{due_date}}", formatDeDate(input.dueDate))
    .replaceAll("{{wero_link_or_id}}", wero);
}

/** Sammel-Text: ein Block pro Person mit offenem Saldo. */
export interface BulkPersonInput {
  name: string;
  /** Aggregierter offener Betrag aller Tranchen */
  totalOpen: number;
  /** Erste offene Tranche (für Label + Fälligkeit) */
  firstOpenTranche: { label: string; due_date: string };
}

export function renderBulkWhatsAppText(params: {
  template?: string | null;
  tripName: string;
  weroLink?: string | null;
  weroId?: string | null;
  persons: BulkPersonInput[];
}): string {
  if (params.persons.length === 0) return "";
  const blocks = params.persons.map((p) =>
    renderWhatsAppText({
      template: params.template,
      name: p.name,
      trancheLabel: p.firstOpenTranche.label,
      tripName: params.tripName,
      amount: p.totalOpen,
      dueDate: p.firstOpenTranche.due_date,
      weroLink: params.weroLink,
      weroId: params.weroId,
    }),
  );
  return blocks.join("\n\n———\n\n");
}

function formatDeDate(iso: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${Number(d)}.${Number(m)}.${y}`;
}
