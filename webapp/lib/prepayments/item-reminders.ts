/**
 * Automatische Erinnerungen für Reise-Posten (PR5, Migration 0061) — reine
 * Planungslogik ohne DB-Zugriff, damit Fenstergrenzen und Empfängerauswahl
 * per Vitest abgesichert sind. Der Cron (app/api/cron/prepayment-reminders)
 * lädt die Daten gesammelt und übergibt sie hier.
 *
 * Zwei Arten (Pendant zu crew_3d / advancer_3d der Charteranzahlung):
 *   • item_crew_3d  — an jede Person mit offenem Posten-Soll, ab
 *     ITEM_CREW_WINDOW_DAYS (= 6) Tage vor der Fälligkeit beim Anbieter, also
 *     3 Tage vor der Crewfrist (toCrewDueDate, 3 Tage Puffer — Entscheidung
 *     des Nutzers: exakt wie bei der Charteranzahlung).
 *   • item_payee_3d — an den Empfänger des Postens, ab ITEM_PAYEE_WINDOW_DAYS
 *     (= 3) Tage vor der Fälligkeit, solange der Anbieter nicht voll bezahlt
 *     ist (Pendant Advancer-Skip).
 *
 * Fenster statt exaktem Tag: ein ausgefallener Cron-Tag verliert nichts, der
 * Dedup-Log sorgt für „höchstens einmal". Eine bereits verstrichene Frist
 * wird (wie bei den Tranchen) nicht mehr beworben.
 *
 * Spec: docs/prepayments.md, Abschnitt „Weitere Posten — Erinnerungen (PR5)".
 */

import { CREW_DUE_DAYS_BEFORE_CHARTER } from "@/lib/prepayments/dates";
import { itemCellStatus } from "@/lib/calc/prepayment-item-shares";
import { round2 } from "@/lib/utils";

/** Tage vor der Fälligkeit beim Anbieter, ab denen der Empfänger erinnert wird. */
export const ITEM_PAYEE_WINDOW_DAYS = 3;
/** Tage vor der Fälligkeit beim Anbieter, ab denen die Crew erinnert wird (= 3 Tage vor Crewfrist). */
export const ITEM_CREW_WINDOW_DAYS = ITEM_PAYEE_WINDOW_DAYS + CREW_DUE_DAYS_BEFORE_CHARTER;

const TOL = 0.005;

export type ItemReminderType = "item_crew_3d" | "item_payee_3d";

export interface ReminderItem {
  id: string;
  trip_id: string;
  label: string;
  total_amount: number;
  due_date: string | null;
  payee_person_id: string;
}

export interface ReminderTrip {
  id: string;
  end_date: string | null;
  archived: boolean | null;
  retention_purged_at: string | null;
}

export interface ItemReminderInput {
  todayIso: string;
  items: ReminderItem[];
  trips: ReminderTrip[];
  obligations: { item_id: string; person_id: string; amount: number }[];
  /** Bestätigte Crew-Zahlungen (v_prepayment_item_payments). */
  payments: { item_id: string; person_id: string | null; paid_amount: number }[];
  /** Offene Selbstmeldungen (v_prepayment_item_pending). */
  pending: { item_id: string; person_id: string | null; amount: number }[];
  /** Anbieter-Zahlungen (Ausgaben mit item_id, nicht gelöscht). */
  providerPayments: { item_id: string; amount: number }[];
  /** Bereits verschickte Erinnerungen (prepayment_item_reminder_log). */
  sentLog: { item_id: string; person_id: string; reminder_type: string }[];
}

export interface ItemReminderJob {
  type: ItemReminderType;
  itemId: string;
  tripId: string;
  personId: string;
  /** Crew: noch offener Betrag der Person. Empfänger: noch an den Anbieter offen. */
  amount: number;
  /** Nur Crew: Soll der Person an diesem Posten. */
  soll?: number;
  /** Nur Empfänger-Übersicht: Kennzahlen des Postens. */
  overview?: ItemPayeeOverview;
}

export interface ItemPayeeOverview {
  /** Posten-Summe = Soll gegenüber dem Anbieter. */
  providerSoll: number;
  /** Σ bestätigte Crew-Zahlungen an den Empfänger — OHNE seine eigene Selbstverrechnung. */
  crewPaid: number;
  /** Σ Crew-Soll (ohne den Empfänger) — zum Vergleich. */
  crewSoll: number;
  /** Bereits an den Anbieter überwiesen. */
  providerPaid: number;
  /** Noch an den Anbieter offen (≥ 0). */
  providerOpen: number;
  /** Eigener Anteil des Empfängers, der noch nicht per Selbstverrechnung erfasst ist. */
  ownOpen: number;
}

/** Vorzeichenbehaftete, EXKLUSIVE Tagesdifferenz (gleicher Tag → 0). Siehe signedDaysUntil im Cron. */
export function daysUntil(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00Z`).getTime();
  const to = new Date(`${toIso}T00:00:00Z`).getTime();
  return Math.round((to - from) / 86_400_000);
}

/**
 * Liegt die Fälligkeit im Erinnerungsfenster? Inklusive Grenzen: am Tag der
 * Fälligkeit (0) und genau `windowDays` vorher. Verstrichen (< 0) → nein.
 */
export function inReminderWindow(todayIso: string, dueIso: string | null, windowDays: number): boolean {
  if (!dueIso) return false;
  const d = daysUntil(todayIso, dueIso);
  return d >= 0 && d <= windowDays;
}

/** Ist der Törn noch einer, für den erinnert wird? (nicht vorbei, archiviert oder gepurged) */
export function tripAcceptsReminders(trip: ReminderTrip | undefined, todayIso: string): boolean {
  if (!trip) return false;
  if (trip.archived) return false;
  if (trip.retention_purged_at) return false;
  if (trip.end_date && trip.end_date < todayIso) return false;
  return true;
}

const key = (itemId: string, personId: string, type: string) => `${itemId}::${personId}::${type}`;

/**
 * Plant alle fälligen Posten-Erinnerungen dieses Laufs. Rein — derselbe
 * Input ergibt dieselben Jobs.
 */
export function planItemReminderJobs(input: ItemReminderInput): ItemReminderJob[] {
  const { todayIso } = input;
  const tripById = new Map(input.trips.map((t) => [t.id, t]));
  const sent = new Set(input.sentLog.map((r) => key(r.item_id, r.person_id, r.reminder_type)));

  const sum = <T>(rows: T[], pick: (r: T) => [string | null, number]) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const [k, v] = pick(r);
      if (k) m.set(k, (m.get(k) ?? 0) + v);
    }
    return m;
  };
  const paidBy = sum(input.payments, (p) => [p.person_id ? `${p.item_id}::${p.person_id}` : null, Number(p.paid_amount)]);
  const pendingBy = sum(input.pending, (p) => [p.person_id ? `${p.item_id}::${p.person_id}` : null, Number(p.amount)]);
  const providerPaidBy = sum(input.providerPayments, (p) => [p.item_id, Number(p.amount)]);

  const jobs: ItemReminderJob[] = [];

  for (const item of input.items) {
    if (!item.due_date) continue; // ohne Frist keine Erinnerung
    if (!tripAcceptsReminders(tripById.get(item.trip_id), todayIso)) continue;

    const obligations = input.obligations.filter((o) => o.item_id === item.id && Number(o.amount) > TOL);
    // Posten ohne Soll → kaputt bzw. nichts einzusammeln, keine Erinnerung.
    if (obligations.length === 0) continue;

    // ── Crew ────────────────────────────────────────────────────────────
    if (inReminderWindow(todayIso, item.due_date, ITEM_CREW_WINDOW_DAYS)) {
      for (const o of obligations) {
        // Der Empfänger zahlt nicht „an sich selbst" — sein eigener Anteil
        // steht in seiner Übersicht (ownOpen). Pendant: der Vorstrecker
        // bekommt kein crew_3d.
        if (o.person_id === item.payee_person_id) continue;
        const soll = Number(o.amount);
        const paid = paidBy.get(`${item.id}::${o.person_id}`) ?? 0;
        const pend = pendingBy.get(`${item.id}::${o.person_id}`) ?? 0;
        const status = itemCellStatus(soll, paid, pend);
        // paid/overpaid: nichts offen. pending: Person hat gemeldet und wartet
        // auf den Empfänger (Pending-Awareness, wie bei den Tranchen).
        if (status !== "open" && status !== "underpaid") continue;
        if (sent.has(key(item.id, o.person_id, "item_crew_3d"))) continue;
        jobs.push({
          type: "item_crew_3d",
          itemId: item.id,
          tripId: item.trip_id,
          personId: o.person_id,
          amount: round2(soll - paid),
          soll: round2(soll),
        });
      }
    }

    // ── Empfänger ───────────────────────────────────────────────────────
    if (inReminderWindow(todayIso, item.due_date, ITEM_PAYEE_WINDOW_DAYS)) {
      const total = Number(item.total_amount);
      const providerPaid = providerPaidBy.get(item.id) ?? 0;
      const providerOpen = total - providerPaid;
      if (providerOpen > TOL && !sent.has(key(item.id, item.payee_person_id, "item_payee_3d"))) {
        let crewPaid = 0;
        let crewSoll = 0;
        let ownSoll = 0;
        for (const o of obligations) {
          if (o.person_id === item.payee_person_id) ownSoll += Number(o.amount);
          else crewSoll += Number(o.amount);
        }
        for (const p of input.payments) {
          if (p.item_id !== item.id || !p.person_id) continue;
          if (p.person_id !== item.payee_person_id) crewPaid += Number(p.paid_amount);
        }
        const ownPaid = paidBy.get(`${item.id}::${item.payee_person_id}`) ?? 0;
        jobs.push({
          type: "item_payee_3d",
          itemId: item.id,
          tripId: item.trip_id,
          personId: item.payee_person_id,
          amount: round2(providerOpen),
          overview: {
            providerSoll: round2(total),
            crewPaid: round2(crewPaid),
            crewSoll: round2(crewSoll),
            providerPaid: round2(providerPaid),
            providerOpen: round2(providerOpen),
            ownOpen: round2(Math.max(0, ownSoll - ownPaid)),
          },
        });
      }
    }
  }

  return jobs;
}

// ────────────────────────────────────────────────────────────────────────
// Manuelle Erinnerung (🔔 in der Personenliste)
// ────────────────────────────────────────────────────────────────────────

/** Struktureller Ausschnitt von `PrepaymentItemView` (kein Server-Import). */
export interface ManualReminderItem {
  id: string;
  trip_id: string;
  total_amount: number;
  payee_person_id: string;
  providerPaid: number;
  cells: { person_id: string; soll: number; paid: number }[];
}

export type ManualReminderPlan =
  | { ok: true; job: ItemReminderJob }
  | { ok: false; message: string };

/**
 * Job für den Klick auf die Glocke — gleiche Mails wie der Cron, aber ohne
 * Fenster und ohne Dedup-Log (der Skipper entscheidet, wann erinnert wird).
 * Crew-Person: Restbetrag ihres Anteils; Empfänger: Übersicht „noch an den
 * Anbieter zu überweisen" (Pendant zur Vorstrecker-Mail des Anzahlungsplans).
 */
export function planManualItemReminder(item: ManualReminderItem, personId: string): ManualReminderPlan {
  const cell = item.cells.find((c) => c.person_id === personId);
  if (personId === item.payee_person_id) {
    const providerOpen = round2(Number(item.total_amount) - Number(item.providerPaid));
    if (providerOpen <= TOL) return { ok: false, message: "Alles an den Anbieter überwiesen — keine Erinnerung nötig." };
    let crewPaid = 0;
    let crewSoll = 0;
    for (const c of item.cells) {
      if (c.person_id === item.payee_person_id) continue;
      crewPaid += c.paid;
      crewSoll += c.soll;
    }
    const own = item.cells.find((c) => c.person_id === item.payee_person_id);
    return {
      ok: true,
      job: {
        type: "item_payee_3d",
        itemId: item.id,
        tripId: item.trip_id,
        personId,
        amount: providerOpen,
        overview: {
          providerSoll: round2(Number(item.total_amount)),
          crewPaid: round2(crewPaid),
          crewSoll: round2(crewSoll),
          providerPaid: round2(Number(item.providerPaid)),
          providerOpen,
          ownOpen: round2(Math.max(0, (own?.soll ?? 0) - (own?.paid ?? 0))),
        },
      },
    };
  }
  if (!cell || cell.soll <= TOL) return { ok: false, message: "Diese Person hat hier keinen Anteil." };
  const open = round2(cell.soll - cell.paid);
  if (open <= TOL) return { ok: false, message: "Nichts offen — keine Erinnerung nötig." };
  return {
    ok: true,
    job: { type: "item_crew_3d", itemId: item.id, tripId: item.trip_id, personId, amount: open, soll: round2(cell.soll) },
  };
}
