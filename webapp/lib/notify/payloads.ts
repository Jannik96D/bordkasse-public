/**
 * Reine Bau-Funktionen für Web-Push-Payloads (Titel / Text / URL / Tag).
 *
 * Bewusst KURZ gehalten — der Lock-Screen zeigt wenig, der volle Kontext
 * steckt in der parallel verschickten Mail (Push + Mail gehen IMMER gemeinsam
 * raus, siehe docs/push-notifications.md). Kein Browser-/DB-Zugriff → direkt
 * mit Vitest testbar.
 *
 * Titel nennen die Sache beim Namen (Label + Betrag/Frist, z. B. „Flüge: dein
 * Anteil 180,00 €"), nie „Posten" (intern `item` = weitere Zahlung; PR7).
 *
 * `tag` collapst gleichartige Pushes: ein zweiter Push mit gleichem Tag
 * ersetzt den vorherigen auf dem Gerät, statt zu stapeln (z. B. „Törn
 * abgerechnet" → später „Bilanz aktualisiert").
 */
import { fmtEuro } from "@/lib/email/mail-shell";
import { NO_DUE_TEXT, PAYMENT_STATUS, cleanLine } from "@/lib/prepayments/payment-words";

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  /** Collapse-Key: gleicher Tag ersetzt eine vorhandene Notification. */
  tag?: string;
  /** true → der Service Worker unterdrückt die Mitteilung NICHT, auch wenn der
   *  Trip gerade im Vordergrund offen ist. Für Events OHNE Realtime-Toast-
   *  Pendant (Abrechnung schreibt nur `trips`, was RealtimeTrip nicht abonniert
   *  → sonst sähe die fokussierte Crew gar nichts). */
  alwaysShow?: boolean;
}

const tripUrl = (tripId: string, sub = "") => `/trips/${tripId}${sub}`;

export function settlementAnnouncedPush(tripName: string, tripId: string): PushPayload {
  return {
    title: "Törn abgerechnet",
    body: `„${tripName}" ist abgerechnet. Tippe für Abrechnung.`,
    url: tripUrl(tripId, "/debts"),
    tag: `settlement-${tripId}`,
    alwaysShow: true,
  };
}

export function settlementUpdatedPush(tripName: string, tripId: string): PushPayload {
  return {
    title: "Bilanz aktualisiert",
    body: `Die Abrechnung für „${tripName}" hat sich geändert.`,
    url: tripUrl(tripId, "/debts"),
    // Gleicher Tag wie die Ankündigung → ersetzt sie statt zu stapeln.
    tag: `settlement-${tripId}`,
    alwaysShow: true,
  };
}

/**
 * An die Gegenpartei eines abgehakten Schuldpostens. `recipientRole` ist die
 * Rolle des EMPFÄNGERS dieses Pushes (nicht des Auslösers): Bekommt der
 * Gläubiger den Push, hat der Schuldner abgehakt — und umgekehrt.
 */
export function debtSettledPush(args: {
  recipientRole: "debtor" | "creditor";
  actorRole: "debtor" | "creditor" | "other";
  actorName: string;
  amount: number;
  tripId: string;
  fromPersonId: string;
  toPersonId: string;
}): PushPayload {
  let body: string;
  if (args.recipientRole === "creditor") {
    // Empfänger = Gläubiger → jemand (Schuldner oder Admin) hat „bezahlt" gesetzt.
    body = `${args.actorName} hat ${fmtEuro(args.amount)} als bezahlt markiert.`;
  } else if (args.actorRole === "creditor") {
    // Empfänger = Schuldner, der Gläubiger hat den Empfang bestätigt.
    body = `${args.actorName} hat den Empfang von ${fmtEuro(args.amount)} bestätigt.`;
  } else {
    // Empfänger = Schuldner, eine dritte Person (Admin) hat abgehakt.
    body = `${args.actorName} hat eure Zahlung über ${fmtEuro(args.amount)} abgehakt.`;
  }
  return {
    title: "Zahlung abgehakt",
    body,
    url: tripUrl(args.tripId, "/debts"),
    tag: `debt-${args.tripId}-${args.fromPersonId}-${args.toPersonId}`,
  };
}

/** „bis 12.10. · „Ostsee“" bzw. „Frist folgt · …". */
const dueBody = (due: string | null | undefined, tripName: string) =>
  `${due ? `Bis ${due}` : NO_DUE_TEXT} · „${tripName}“`;
const updatePrefix = (isUpdate: boolean) => (isUpdate ? "Geändert: " : "");

/** Erinnerung an die Crew zu einer Rate des Anzahlungsplans (crew_3d). */
export function prepaymentReminderPush(args: {
  trancheLabel: string;
  amount: number;
  tripName: string;
  tripId: string;
  trancheId: string;
  /** Formatierte Crewfrist; ohne → „Frist folgt". */
  due?: string | null;
}): PushPayload {
  return {
    title: `${cleanLine(args.trancheLabel)}: dein Anteil ${fmtEuro(args.amount)}`,
    body: dueBody(args.due, args.tripName),
    url: tripUrl(args.tripId, "/prepayments"),
    tag: `prepay-${args.trancheId}`,
  };
}

/** Erinnerung an die vorstreckende Person (advancer_3d). */
export function charterReminderPush(args: {
  tripName: string;
  tripId: string;
  trancheId: string;
  /** Noch an den Anbieter zu überweisen. */
  amount?: number;
  /** Anbieter-Frist (formatiert). */
  due?: string | null;
  /** Bezeichnung der Sache, z. B. „Yachtanzahlung". */
  what?: string;
}): PushPayload {
  const what = cleanLine(args.what ?? "Anzahlung");
  return {
    title:
      args.amount !== undefined
        ? `${what}: noch ${fmtEuro(args.amount)} an Anbieter überweisen`
        : `${what}: Überweisung an Anbieter steht an`,
    body: dueBody(args.due, args.tripName),
    url: tripUrl(args.tripId, "/prepayments"),
    tag: `charter-${args.trancheId}`,
  };
}

/** Erinnerung an die Crew zu einer weiteren Zahlung (item_crew_3d, PR5). */
export function itemReminderPush(args: {
  itemLabel: string;
  amount: number;
  tripName: string;
  tripId: string;
  itemId: string;
  due?: string | null;
}): PushPayload {
  return {
    title: `${cleanLine(args.itemLabel)}: dein Anteil ${fmtEuro(args.amount)}`,
    body: dueBody(args.due, args.tripName),
    url: tripUrl(args.tripId, "/prepayments"),
    tag: `item-${args.itemId}`,
  };
}

/** Übersicht an die vorstreckende Person (item_payee_3d, PR5). */
export function itemPayeeReminderPush(args: {
  itemLabel: string;
  amount: number;
  tripName: string;
  tripId: string;
  itemId: string;
  due?: string | null;
}): PushPayload {
  return {
    title: `${cleanLine(args.itemLabel)}: noch ${fmtEuro(args.amount)} an Anbieter überweisen`,
    body: dueBody(args.due, args.tripName),
    url: tripUrl(args.tripId, "/prepayments"),
    tag: `item-payee-${args.itemId}`,
  };
}

/** Meldung zu einer Rate des Anzahlungsplans → an die vorstreckende Person. */
export function paymentPendingPush(args: {
  payerName: string;
  amount: number;
  tripId: string;
  trancheId: string;
  payerPersonId: string;
  /** Bezeichnung der Sache (z. B. „1. Anzahlung"). */
  what?: string;
}): PushPayload {
  return {
    title: `${cleanLine(args.what ?? "Einzahlung")}: ${fmtEuro(args.amount)} von ${cleanLine(args.payerName)}`,
    body: `Einzahlung ${PAYMENT_STATUS.pending}. Bitte bestätigen oder ablehnen.`,
    url: tripUrl(args.tripId, "/prepayments"),
    // Pro (Trip, Tranche, Melder) eindeutig → zwei verschiedene Selbstmeldungen
    // kollabieren nicht zu einer; die vorstreckende Person muss jede einzeln bestätigen.
    tag: `pending-${args.tripId}-${args.trancheId}-${args.payerPersonId}`,
  };
}

export function paymentConfirmedPush(args: { amount: number; tripId: string }): PushPayload {
  return {
    title: `Einzahlung ${PAYMENT_STATUS.confirmed}`,
    body: `Deine Einzahlung von ${fmtEuro(args.amount)} wurde ${PAYMENT_STATUS.confirmed}.`,
    url: tripUrl(args.tripId, "/prepayments"),
  };
}

export function paymentRejectedPush(args: { amount: number; tripId: string }): PushPayload {
  return {
    title: `Einzahlung ${PAYMENT_STATUS.rejected}`,
    body: `Deine gemeldete Einzahlung von ${fmtEuro(args.amount)} wurde ${PAYMENT_STATUS.rejected}. Bitte prüfen.`,
    url: tripUrl(args.tripId, "/prepayments"),
  };
}

// ── Weitere Zahlungen & Anzahlungsplan (PR6, Wording PR7) ───────────────────

/** Meldung zu einer weiteren Zahlung → an die vorstreckende Person. */
export function itemPaymentPendingPush(args: {
  payerName: string;
  itemLabel: string;
  amount: number;
  tripId: string;
  itemId: string;
  payerPersonId: string;
}): PushPayload {
  return {
    title: `${cleanLine(args.itemLabel)}: ${fmtEuro(args.amount)} von ${cleanLine(args.payerName)}`,
    body: `Einzahlung ${PAYMENT_STATUS.pending}. Bitte bestätigen oder ablehnen.`,
    url: tripUrl(args.tripId, "/prepayments"),
    // Pro (Zahlung, Melder) eindeutig — jede Meldung wird einzeln bestätigt.
    tag: `item-pending-${args.itemId}-${args.payerPersonId}`,
  };
}

/** Einzahlung erfasst/bestätigt/abgelehnt → an zahlende bzw. vorstreckende Person. */
export function itemPaymentNoticePush(args: {
  kind: "item_payment_recorded" | "item_payment_confirmed" | "item_payment_rejected";
  role: "payer" | "payee";
  payerName: string;
  itemLabel: string;
  amount: number;
  tripId: string;
}): PushPayload {
  const whose = args.role === "payer" ? "Deine Einzahlung" : `Die Einzahlung von ${args.payerName}`;
  const amount = fmtEuro(args.amount);
  const map = {
    item_payment_recorded: { title: `${cleanLine(args.itemLabel)}: Einzahlung erfasst`, body: `${whose} über ${amount} wurde erfasst.` },
    item_payment_confirmed: {
      title: `${cleanLine(args.itemLabel)}: Einzahlung ${PAYMENT_STATUS.confirmed}`,
      body: `${whose} über ${amount} wurde ${PAYMENT_STATUS.confirmed}.`,
    },
    item_payment_rejected: {
      title: `${cleanLine(args.itemLabel)}: Einzahlung ${PAYMENT_STATUS.rejected}`,
      body: `${args.role === "payer" ? "Deine Meldung" : `Die Meldung von ${args.payerName}`} über ${amount} wurde ${PAYMENT_STATUS.rejected}. Bitte prüfen.`,
    },
  } as const;
  return { ...map[args.kind], url: tripUrl(args.tripId, "/prepayments") };
}

/** Weitere Zahlung angelegt / geändert (Crew informieren). */
export function itemAnnouncedPush(args: {
  isUpdate: boolean;
  itemLabel: string;
  /** Anteil der Person; null = Übersicht für die vorstreckende Person. */
  amount: number | null;
  tripName: string;
  tripId: string;
  itemId: string;
  /** Formatierte Crewfrist (Anteil) bzw. Anbieter-Frist (Übersicht). */
  due?: string | null;
}): PushPayload {
  const prefix = updatePrefix(args.isUpdate);
  return {
    title:
      args.amount !== null
        ? `${prefix}${cleanLine(args.itemLabel)}: dein Anteil ${fmtEuro(args.amount)}`
        : `${prefix}${cleanLine(args.itemLabel)}: du streckst vor`,
    body: args.amount !== null ? dueBody(args.due, args.tripName) : `Übersicht für „${args.tripName}“ in der App.`,
    url: tripUrl(args.tripId, "/prepayments"),
    tag: `item-announce-${args.itemId}`,
  };
}

/** Anzahlungsplan angelegt / geändert (Crew informieren). */
export function planAnnouncedPush(args: {
  isUpdate: boolean;
  /** Gesamtanteil der Person; null = Übersicht für die vorstreckende Person. */
  amount: number | null;
  tripName: string;
  tripId: string;
  /** Bezeichnung der Sache (z. B. „Yachtanzahlung"); Default „Anzahlungsplan". */
  what?: string;
  /** Nächste Frist (formatiert). */
  due?: string | null;
}): PushPayload {
  const prefix = updatePrefix(args.isUpdate);
  const what = cleanLine(args.what ?? "Anzahlungsplan");
  return {
    title:
      args.amount !== null
        ? `${prefix}${what}: dein Anteil ${fmtEuro(args.amount)}`
        : `${prefix}${what}: du streckst vor`,
    body: args.amount !== null ? dueBody(args.due, args.tripName) : `Übersicht für „${args.tripName}“ in der App.`,
    url: tripUrl(args.tripId, "/prepayments"),
    tag: `plan-announce-${args.tripId}`,
  };
}
