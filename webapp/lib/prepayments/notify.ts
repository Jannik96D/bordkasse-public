/**
 * Reine Regeln für die Benachrichtigungen rund um Anzahlungsplan und
 * Reise-Posten (PR6). Kein DB-/Mail-Zugriff → direkt mit Vitest testbar.
 * Versand: lib/email/send-prepayment-notices.ts.
 *
 * Grundregeln (wie bei den Tranchen-Mails, docs/prepayments.md):
 *   • Wer die Aktion auslöst (Aktor), bekommt nichts über die eigene Aktion.
 *   • Eine Person bekommt höchstens EINE Mail pro Ereignis.
 *   • Der Empfänger des Geldes (Posten-Empfänger bzw. vorstreckende Person)
 *     bekommt statt der Crew-Variante eine eigene Übersicht — sein eigener
 *     Anteil ist eine Selbstverrechnung, keine Zahlung „an sich selbst".
 */

import { toCrewDueDate, formatDeDate } from "@/lib/prepayments/dates";
import { round2 } from "@/lib/utils";
import { allocateByWeights } from "@/lib/calc/prepayment-shares";

export interface SollEntry {
  personId: string;
  amount: number;
}

export interface AnnounceRecipients {
  /** Crew mit Soll > 0, ohne Aktor und ohne Geld-Empfänger. */
  crew: SollEntry[];
  /** Geld-Empfänger, sofern er nicht selbst der Aktor ist. */
  payeeId: string | null;
}

/**
 * Empfänger der Mails „Posten angelegt" / „Anzahlungsplan angelegt" und der
 * Update-Variante („Crew informieren"): alle Personen mit Soll > 0 (ein Soll
 * von 0 — z. B. „reist selbst an" — braucht keine Mail), außer dem Aktor und
 * außer dem Geld-Empfänger, der stattdessen die Übersicht bekommt.
 */
export function announceRecipients(args: {
  soll: SollEntry[];
  payeeId: string;
  actorId: string | null;
}): AnnounceRecipients {
  const seen = new Set<string>();
  const crew: SollEntry[] = [];
  for (const s of args.soll) {
    if (!(s.amount > 0.005)) continue;
    if (s.personId === args.payeeId || s.personId === args.actorId) continue;
    if (seen.has(s.personId)) continue;
    seen.add(s.personId);
    crew.push({ personId: s.personId, amount: round2(s.amount) });
  }
  return { crew, payeeId: args.payeeId === args.actorId ? null : args.payeeId };
}

export type ItemNoticeKind = "item_payment_recorded" | "item_payment_confirmed" | "item_payment_rejected";

export interface ItemNoticeRecipient {
  personId: string;
  role: "payer" | "payee";
}

/**
 * Empfänger der Info-Mails zu einer Posten-Zahlung:
 *   • erfasst durch Dritte → zahlende Person + Empfänger
 *   • bestätigt / abgelehnt → zahlende Person (und der Empfänger, wenn ein
 *     Dritter — Skipper/Admin — statt seiner gehandelt hat)
 * Der Aktor ist immer ausgenommen; zahlt der Empfänger selbst
 * (Selbstverrechnung), gibt es nur eine Rolle („payer").
 */
export function itemNoticeRecipients(args: {
  actorId: string;
  payerId: string | null;
  payeeId: string;
}): ItemNoticeRecipient[] {
  const out: ItemNoticeRecipient[] = [];
  if (args.payerId && args.payerId !== args.actorId) out.push({ personId: args.payerId, role: "payer" });
  if (args.payeeId !== args.actorId && args.payeeId !== args.payerId) {
    out.push({ personId: args.payeeId, role: "payee" });
  }
  return out;
}

/** Leere bzw. nur aus Leerzeichen bestehende Wero-ID → null. */
export function normalizeWeroId(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  return v === "" ? null : v;
}

/**
 * Wero-ID für eine Posten-Mail. Posten haben keine eigene Wero-ID; die des
 * Anzahlungsplans gehört der vorstreckenden Person. Sie wird NUR genannt,
 * wenn genau diese Person auch den Posten empfängt — sonst landete das Geld
 * per Wero bei der falschen Person. Keine (passende) ID → null → die Mail
 * erwähnt Wero überhaupt nicht.
 */
export function weroIdForItem(args: {
  planWeroId: string | null | undefined;
  advancerId: string | null;
  payeeId: string;
}): string | null {
  if (!args.advancerId || args.advancerId !== args.payeeId) return null;
  return normalizeWeroId(args.planWeroId);
}

/**
 * Crewfrist für die Mail: Fälligkeit beim Anbieter minus 3 Tage Puffer
 * (inkl. Clamp aus toCrewDueDate), deutsch formatiert. Ohne Fälligkeit → null
 * (das Template schreibt dann „Frist folgt").
 */
export function crewDueLabel(dueDate: string | null | undefined, todayIso?: string): string | null {
  if (!dueDate) return null;
  return formatDeDate(todayIso ? toCrewDueDate(dueDate, todayIso) : toCrewDueDate(dueDate));
}

/**
 * Raten einer Person für die Mails (Review-Fund Cent-Drift): Largest-Remainder
 * über die Tranchen-Prozente, damit Σ Raten EXAKT dem Gesamtanteil entspricht
 * (100,01 € auf 50/50 → 50,01 + 50,00 statt 2 × 50,01). Bewusst nur für die
 * neuen Mails: Matrix, Crew-Self-View und Erinnerungsmail rechnen weiter
 * pro Rate `round2(Soll × % / 100)` — eine zentrale Umstellung änderte dort
 * angezeigte Sollbeträge und Statusgrenzen (offen/bezahlt) bestehender Törns.
 */
export function trancheShares(totalSoll: number, percents: number[]): number[] {
  return allocateByWeights(totalSoll, percents);
}

export interface Coverage {
  amount: number;
  /** Davon bestätigt bezahlt. */
  paid: number;
  /** Davon gemeldet, wartet auf Bestätigung. */
  pending: number;
  /** Noch offen (≥ 0). */
  open: number;
}

/**
 * Verteilt bestätigte Zahlungen und offene Selbstmeldungen einer Person auf
 * ihre Raten — in der übergebenen Reihenfolge (Aufrufer sortiert nach
 * Fälligkeit). Erst die bestätigten, danach die gemeldeten Beträge, jeweils
 * „früheste Rate zuerst". Damit wird eine Überzahlung einer Rate gegen die
 * anderen verrechnet (Review-Fund: Rate 2 überzahlt, Rate 1 unterzahlt, Σ
 * gedeckt → nichts offen), und das Gesamt-Offen wird nie negativ. Überschuss
 * über alle Raten hinaus verfällt rechnerisch (er wird nicht als „offen"
 * und nicht als negative Forderung gezeigt). In Cent gerechnet.
 */
export function allocateCoverage(amounts: number[], paidTotal: number, pendingTotal: number): Coverage[] {
  let paidLeft = Math.max(0, Math.round(paidTotal * 100));
  let pendingLeft = Math.max(0, Math.round(pendingTotal * 100));
  return amounts.map((a) => {
    const cents = Math.max(0, Math.round(a * 100));
    const p = Math.min(cents, paidLeft);
    paidLeft -= p;
    const q = Math.min(cents - p, pendingLeft);
    pendingLeft -= q;
    return { amount: cents / 100, paid: p / 100, pending: q / 100, open: (cents - p - q) / 100 };
  });
}

/**
 * Ergebnis-Text für den Knopf „Crew informieren". `skipped` = Personen ohne
 * hinterlegte E-Mail-Adresse (Ghost-Crew) — kein Fehler, aber erwähnenswert.
 */
export function notifyResultMessage(r: { sent: number; failed: number; skipped: number }): {
  message: string;
  variant: "success" | "error" | "info";
} {
  const mails = (n: number) => `${n} ${n === 1 ? "Mail" : "Mails"}`;
  const parts: string[] = [];
  if (r.failed > 0) parts.push(`${mails(r.failed)} nicht zugestellt`);
  if (r.skipped > 0) parts.push(`${r.skipped} ohne E-Mail-Adresse`);
  const extra = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  if (r.sent === 0 && r.failed === 0 && r.skipped === 0) {
    return { message: "Niemand zu informieren — außer dir hat niemand einen Anteil.", variant: "info" };
  }
  if (r.sent === 0) {
    return { message: `Keine Mail verschickt${extra}.`, variant: r.failed > 0 ? "error" : "info" };
  }
  return { message: `${mails(r.sent)} verschickt${extra}.`, variant: r.failed > 0 ? "error" : "success" };
}

/**
 * „zuletzt informiert am …" — feste Zeitzone (Europe/Berlin), damit Server-
 * und Client-Render identisch sind (kein Hydration-Mismatch).
 */
export function formatNotifiedAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
