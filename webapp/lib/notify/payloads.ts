/**
 * Reine Bau-Funktionen für Web-Push-Payloads (Titel / Text / URL / Tag).
 *
 * Bewusst KURZ gehalten — der Lock-Screen zeigt wenig, der volle Kontext
 * steckt in der parallel verschickten Mail (Push + Mail gehen IMMER gemeinsam
 * raus, siehe docs/push-notifications.md). Kein Browser-/DB-Zugriff → direkt
 * mit Vitest testbar.
 *
 * `tag` collapst gleichartige Pushes: ein zweiter Push mit gleichem Tag
 * ersetzt den vorherigen auf dem Gerät, statt zu stapeln (z. B. „Törn
 * abgerechnet" → später „Bilanz aktualisiert").
 */
import { fmtEuro } from "@/lib/email/mail-shell";

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  /** Collapse-Key: gleicher Tag ersetzt eine vorhandene Notification. */
  tag?: string;
}

const tripUrl = (tripId: string, sub = "") => `/trips/${tripId}${sub}`;

export function settlementAnnouncedPush(tripName: string, tripId: string): PushPayload {
  return {
    title: "Törn abgerechnet",
    body: `„${tripName}" ist abgerechnet — tippe für Bilanz & Zahlungsplan.`,
    url: tripUrl(tripId, "/debts"),
    tag: `settlement-${tripId}`,
  };
}

export function settlementUpdatedPush(tripName: string, tripId: string): PushPayload {
  return {
    title: "Bilanz aktualisiert",
    body: `Die Abrechnung für „${tripName}" hat sich geändert.`,
    url: tripUrl(tripId, "/debts"),
    // Gleicher Tag wie die Ankündigung → ersetzt sie statt zu stapeln.
    tag: `settlement-${tripId}`,
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

export function prepaymentReminderPush(args: {
  trancheLabel: string;
  amount: number;
  tripName: string;
  tripId: string;
  trancheId: string;
}): PushPayload {
  return {
    title: "Anzahlung fällig",
    body: `${args.trancheLabel}: ${fmtEuro(args.amount)} für „${args.tripName}".`,
    url: tripUrl(args.tripId, "/prepayments"),
    tag: `prepay-${args.trancheId}`,
  };
}

export function charterReminderPush(args: {
  tripName: string;
  tripId: string;
  trancheId: string;
}): PushPayload {
  return {
    title: "Charteranzahlung fällig",
    body: `Überweisung an den Vercharterer für „${args.tripName}" steht an.`,
    url: tripUrl(args.tripId, "/prepayments"),
    tag: `charter-${args.trancheId}`,
  };
}

export function paymentPendingPush(args: {
  payerName: string;
  amount: number;
  tripId: string;
}): PushPayload {
  return {
    title: "Zahlung gemeldet",
    body: `${args.payerName} meldet ${fmtEuro(args.amount)} — bitte bestätigen oder ablehnen.`,
    url: tripUrl(args.tripId, "/prepayments"),
    tag: `pending-${args.tripId}`,
  };
}

export function paymentConfirmedPush(args: { amount: number; tripId: string }): PushPayload {
  return {
    title: "Zahlung bestätigt",
    body: `Deine Anzahlung von ${fmtEuro(args.amount)} wurde bestätigt.`,
    url: tripUrl(args.tripId, "/prepayments"),
  };
}

export function paymentRejectedPush(args: { amount: number; tripId: string }): PushPayload {
  return {
    title: "Zahlung abgelehnt",
    body: `Deine Anzahlungs-Meldung über ${fmtEuro(args.amount)} wurde abgelehnt — bitte prüfen.`,
    url: tripUrl(args.tripId, "/prepayments"),
  };
}
