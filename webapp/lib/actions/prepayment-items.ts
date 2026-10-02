"use server";

/**
 * Server-Actions für Reise-Posten (Migration 0058/0059, Plan Teil B, PR4a).
 *
 * Ein Posten (z. B. Flüge für die An-/Abreise) ist ein dritter Topf neben
 * Bordkasse und Charter-Pool:
 *   • Anbieter-Zahlung: der Empfänger (`payee_person_id`) zahlt Airline/Bahn
 *     → Ausgabe mit `item_id`, `paid_by` = Empfänger, verteilt `per_person`
 *     nach Soll (recordItemProviderPayment).
 *   • Crew-Zahlung an den Empfänger → Gutschrift mit `item_id`,
 *     `credit_to` = Empfänger (recordItemPayment bzw. Selbstmeldung
 *     submitItemSelfPayment → confirm/reject).
 * Spec: docs/prepayments.md, Abschnitt „Weitere Posten".
 *
 * Für jede Action gilt (Security-Konventionen aus CLAUDE.md):
 *   • Rollen-Check im App-Layer (Service-Role-Client umgeht RLS),
 *   • assertTripNotArchived NACH dem Auth-Guard, VOR jedem Schreiben,
 *   • Cross-Trip-Checks (personsBelongToTrip / itemBelongsToTrip) und
 *     `.eq("trip_id", …)` auf jedem UPDATE/DELETE,
 *   • jeder Supabase-Fehler wird geprüft (kein stilles Weitermachen),
 *     Teilfehler werden — wo es mehrere Schreibschritte gibt — kompensierend
 *     zurückgerollt (Muster createExpense/updateExpense),
 *   • Audit-Log ohne Klartext-PII (keine Namen, keine Freitexte),
 *   • markPostSettlementChange, sobald sich v_balances ändert.
 *
 * Bewusst (noch) ohne Mails/Push: die vorhandenen Templates sind
 * tranchenspezifisch, Posten-Erinnerungen sind laut Plan ein Folgeschritt.
 */

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { requireMember, requireSkipperOrAdmin, requireSkipperAdminOrItemPayee } from "@/lib/auth/authz";
import { assertTripNotArchived } from "@/lib/auth/trip-state";
import { CROSS_TRIP_PERSON_MSG, itemBelongsToTrip, personsBelongToTrip } from "@/lib/auth/cross-trip";
import { logAudit } from "@/lib/db/audit";
import {
  DeleteItemSchema,
  RecordItemPaymentSchema,
  RecordItemProviderPaymentSchema,
  SaveItemSchema,
  SubmitItemSelfPaymentSchema,
} from "@/lib/validation/prepayment-schema";
import {
  allocateItemProviderShares,
  calculateItemObligations,
  type ItemMember,
  type ItemShare,
} from "@/lib/calc/prepayment-item-shares";
import { daysBetween } from "@/lib/utils";
import { z } from "zod";

type AdminClient = ReturnType<typeof createAdminClient>;
type DbError = { code?: string; message: string } | null;

export type ItemActionState =
  | { status: "idle" }
  | { status: "ok"; itemId?: string; duplicate?: boolean }
  | { status: "error"; message: string; field?: string };

const PG_UNIQUE_VIOLATION = "23505";
const ITEM_FOREIGN_MSG = "Dieser Posten gehört nicht zu diesem Törn. Bitte Seite neu laden.";
const ROLLBACK_FAILED_SUFFIX =
  "Achtung: das Zurücksetzen ist ebenfalls fehlgeschlagen — bitte den Posten prüfen oder einen Admin fragen.";

/**
 * Retry-Erkennung über `idempotency_key` (UNIQUE trip_id+key, 0005): nur als
 * Duplikat werten, wenn die bestehende Zeile wirklich DIESELBE Art Buchung
 * für DIESEN Posten ist (Grill-Fund P3-14 — der Key ist client-kontrolliert).
 * Sonst ehrlicher Fehler statt eines vorgetäuschten Erfolgs.
 */
async function isSameItemBooking(
  supabase: AdminClient,
  tripId: string,
  key: string,
  expect: { itemId: string; type: "credit" | "expense" },
): Promise<boolean> {
  const { data, error } = await supabase
    .from("transactions")
    .select("item_id, type")
    .eq("trip_id", tripId)
    .eq("idempotency_key", key)
    .maybeSingle();
  if (error || !data) return false;
  return data.item_id === expect.itemId && data.type === expect.type;
}

function dbErr(err: DbError, fallback: string): string {
  if (err?.message) console.error("[bordkasse:db]", err.message);
  return fallback;
}

/**
 * Übersetzt die stabilen Fehlerschlüssel aus 0058/0059 (Message = Schlüssel,
 * SQLSTATE P0001) und die relevanten CHECK-Verletzungen in deutsche
 * Meldungen. Alles Unbekannte → `fallback` (Original nur im Serverlog).
 */
function itemDbErrorMessage(err: DbError, fallback: string): string {
  const msg = err?.message ?? "";
  if (msg.includes("prepayment_item_has_payments")) {
    return "An diesem Posten hängen bereits bestätigte Zahlungen. Er kann nicht gelöscht werden.";
  }
  if (msg.includes("prepayment_item_has_pending")) {
    return "An diesem Posten hängt noch eine unbestätigte Selbstmeldung. Bitte erst bestätigen oder ablehnen.";
  }
  if (msg.includes("prepayment_item_credit_wrong_payee")) {
    return "Eine Zahlung für diesen Posten muss an die Person gehen, die ihn empfängt.";
  }
  if (msg.includes("prepayment_item_payee_has_credits")) {
    return "Der Empfänger kann gerade nicht gewechselt werden, weil Zahlungen an ihn hängen. Bitte erneut versuchen.";
  }
  if (msg.includes("prepayment_item_payee_invalid") || msg.includes("prepayment_item_not_found")) {
    return "Posten oder Empfänger nicht gefunden. Bitte Seite neu laden.";
  }
  if (msg.includes("tx_pool_exclusive")) {
    return "Eine Buchung kann nicht gleichzeitig einer Anzahlungstranche und einem Posten zugeordnet sein.";
  }
  if (msg.includes("tx_item_credit_direct")) {
    return "Eine Zahlung für einen Posten braucht einen konkreten Empfänger (nicht „An Alle“).";
  }
  return dbErr(err, fallback);
}

async function markPostSettlementChange(supabase: AdminClient, tripId: string): Promise<void> {
  const { error } = await supabase.rpc("mark_post_settlement_change", { p_trip_id: tripId });
  if (error) console.error("[bordkasse:settlement-resend]", error.message);
}

function revalidateItemPaths(tripId: string, opts: { balance?: boolean } = {}): void {
  revalidatePath(`/trips/${tripId}/prepayments`);
  revalidatePath(`/trips/${tripId}`);
  if (opts.balance) {
    revalidatePath(`/trips/${tripId}/balance`);
    revalidatePath(`/trips/${tripId}/transactions`);
    revalidatePath(`/trips/${tripId}/stats`);
  }
}

function parsePayload(formData: FormData): { ok: true; json: unknown } | { ok: false; message: string } {
  const raw = formData.get("payload");
  if (typeof raw !== "string") return { ok: false, message: "Payload fehlt." };
  try {
    return { ok: true, json: JSON.parse(raw) };
  } catch {
    return { ok: false, message: "Ungültiges Payload-JSON." };
  }
}

function zodMessage(error: z.ZodError): { message: string; field?: string } {
  const first = error.issues[0];
  return { message: first?.message ?? "Ungültige Eingabe.", field: first?.path?.[0]?.toString() };
}

interface ItemRow {
  id: string;
  trip_id: string;
  category_id: string | null;
  label: string;
  total_amount: number;
  due_date: string | null;
  payee_person_id: string;
  split_type: string;
  sort_order: number;
}

const ITEM_COLS = "id, trip_id, category_id, label, total_amount, due_date, payee_person_id, split_type, sort_order";

/** Lädt einen Posten DIESES Törns (trip_id-Filter = Cross-Trip-Schutz). */
async function loadItem(
  supabase: AdminClient,
  tripId: string,
  itemId: string,
): Promise<{ ok: true; item: ItemRow } | { ok: false; message: string }> {
  const { data, error } = await supabase
    .from("prepayment_items")
    .select(ITEM_COLS)
    .eq("id", itemId)
    .eq("trip_id", tripId)
    .maybeSingle();
  if (error) return { ok: false, message: dbErr(error, "Posten konnte nicht geladen werden.") };
  if (!data) return { ok: false, message: ITEM_FOREIGN_MSG };
  return { ok: true, item: { ...(data as ItemRow), total_amount: Number(data.total_amount) } };
}

/** Soll-Zeilen eines Postens; Fehler → fail-loud. */
async function loadObligations(
  supabase: AdminClient,
  tripId: string,
  itemId: string,
): Promise<{ ok: true; rows: ItemShare[] } | { ok: false; message: string }> {
  const { data, error } = await supabase
    .from("prepayment_item_obligations")
    .select("person_id, amount")
    .eq("trip_id", tripId)
    .eq("item_id", itemId);
  if (error) return { ok: false, message: dbErr(error, "Sollbeträge konnten nicht geladen werden.") };
  return {
    ok: true,
    rows: (data ?? []).map((r) => ({ personId: r.person_id as string, amount: Number(r.amount) })),
  };
}

/** Anbieter-Zahlungen (Ausgaben mit item_id, nicht gelöscht) eines Postens. */
async function loadProviderPayments(
  supabase: AdminClient,
  tripId: string,
  itemId: string,
): Promise<{ ok: true; rows: { id: string; amount: number }[] } | { ok: false; message: string }> {
  const { data, error } = await supabase
    .from("transactions")
    .select("id, amount")
    .eq("trip_id", tripId)
    .eq("item_id", itemId)
    .eq("type", "expense")
    .is("deleted_at", null);
  if (error) return { ok: false, message: dbErr(error, "Anbieter-Zahlungen konnten nicht geladen werden.") };
  return { ok: true, rows: (data ?? []).map((r) => ({ id: r.id as string, amount: Number(r.amount) })) };
}

/**
 * Passen die per_person-Anteile der Anbieter-Zahlungen zu `soll`? Erwartet
 * wird die kumulative Verteilung von Σ Zahlungen nach Soll (genau das, was
 * allocateItemProviderShares erzeugt). Grill-Fund (Delta): hat eine parallele
 * Anbieter-Zahlung schon nach dem NEUEN Soll verteilt, darf saveItem nicht
 * blind auf das alte Soll zurückrollen — sonst passten die Anteile danach
 * nicht mehr. Lesefehler → false (dann rollt saveItem zurück, fail-safe).
 */
async function providerSharesMatchSoll(
  supabase: AdminClient,
  payments: { id: string; amount: number }[],
  soll: ItemShare[],
): Promise<boolean> {
  const { data, error } = await supabase
    .from("transaction_participants")
    .select("person_id, amount")
    .in("transaction_id", payments.map((p) => p.id));
  if (error) return false;
  const total = payments.reduce((s, p) => s + p.amount, 0);
  const expected = allocateItemProviderShares(total, soll);
  const actual = new Map<string, number>();
  for (const r of data ?? []) {
    actual.set(r.person_id as string, (actual.get(r.person_id as string) ?? 0) + Math.round(Number(r.amount ?? 0) * 100));
  }
  const exp = new Map(expected.map((e) => [e.personId, Math.round(e.amount * 100)]));
  const ids = new Set([...actual.keys(), ...exp.keys()]);
  return [...ids].every((id) => (actual.get(id) ?? 0) === (exp.get(id) ?? 0));
}

/** Σ Soll je Person mit Betrag > 0 als vergleichbare Signatur. */
function sollSignature(rows: ItemShare[]): string {
  return rows
    .filter((r) => r.amount > 0.005)
    .map((r) => `${r.personId}:${Math.round(r.amount * 100)}`)
    .sort()
    .join("|");
}

// ────────────────────────────────────────────────────────────────────────
// 1. Posten anlegen / ändern
// ────────────────────────────────────────────────────────────────────────

/**
 * Legt einen Posten an oder ändert ihn und verteilt das Soll neu (gleiche
 * Semantik wie savePrepaymentPlan: Delete + Insert der Sollzeilen).
 * Erwartet ein JSON im Feld `payload` (SaveItemSchema).
 *
 * Sperren, sobald eine Anbieter-Zahlung gebucht ist (PR4-Checkliste
 * „beim Speichern des Solls nachziehen oder sperren" → sperren):
 *   • eine Änderung der Soll-Verteilung (Betrag, Aufteilung, Einzelbeträge)
 *     — die Anteile der
 *     Anbieter-Ausgabe (per_person) wurden aus dem alten Soll berechnet;
 *     ein stilles Nachziehen müsste fremde Buchungen in mehreren
 *     Schreibschritten ohne echte Transaktion umschreiben. Ausweg: Anbieter-
 *     Zahlung in der Buchungsliste löschen, Posten ändern, neu erfassen.
 *   • ein Empfängerwechsel — die Anbieter-Zahlung hat der bisherige
 *     Empfänger wirklich geleistet; die Crew-Gutschriften gingen dann an
 *     jemand anderen, und zwischen den beiden entstünde eine Schuld, die kein
 *     Schulden-Tab zeigt (Posten sind dort bewusst ausgeschlossen).
 * Bezeichnung, Kategorie, Fälligkeit und Reihenfolge bleiben immer änderbar;
 * dabei bleibt das gespeicherte Soll unangetastet (es wird NICHT aus der
 * inzwischen evtl. geänderten Crew neu berechnet).
 *
 * Empfängerwechsel OHNE Anbieter-Zahlung läuft über `move_item_payee`
 * (Migration 0059): bisherige Crew-Gutschriften wandern zum neuen Empfänger.
 */
export async function saveItem(_prev: ItemActionState, formData: FormData): Promise<ItemActionState> {
  const person = await getCurrentPerson();
  if (!person) return { status: "error", message: "Nicht angemeldet." };

  const payload = parsePayload(formData);
  if (!payload.ok) return { status: "error", message: payload.message };
  const parsed = SaveItemSchema.safeParse(payload.json);
  if (!parsed.success) return { status: "error", ...zodMessage(parsed.error) };
  const input = parsed.data;
  const tripId = input.trip_id;

  const auth = await requireSkipperOrAdmin(tripId);
  if (!auth.ok) return { status: "error", message: auth.message };

  const supabase = createAdminClient();
  const archivedCheck = await assertTripNotArchived(supabase, tripId);
  if (!archivedCheck.ok) return { status: "error", message: archivedCheck.message };

  // ── Reads (alle VOR dem ersten Write) ─────────────────────────────────
  const tripRes = await supabase
    .from("trips")
    .select("skipper_id, start_date, end_date")
    .eq("id", tripId)
    .maybeSingle();
  if (tripRes.error) return { status: "error", message: dbErr(tripRes.error, "Törndaten konnten nicht geladen werden.") };
  if (!tripRes.data) return { status: "error", message: "Törn nicht gefunden." };
  const trip = tripRes.data;

  // Bestehender Posten? Die ID ist client-kontrolliert (Idempotenz) und darf
  // NIE einen Posten eines anderen Törns adressieren (Klasse Fund F1 — sonst
  // überschriebe ein Skipper von Törn X über eine Fremd-ID den Posten von Y).
  // Deshalb global nachschlagen statt nur in diesem Törn.
  const itemId = input.id ?? crypto.randomUUID();
  let existing: ItemRow | null = null;
  if (input.id) {
    const { data, error } = await supabase.from("prepayment_items").select(ITEM_COLS).eq("id", input.id).maybeSingle();
    if (error) return { status: "error", message: dbErr(error, "Posten konnte nicht geladen werden.") };
    if (data && data.trip_id !== tripId) return { status: "error", message: ITEM_FOREIGN_MSG };
    if (data) existing = { ...(data as ItemRow), total_amount: Number(data.total_amount) };
  }

  const payeeId = input.payee_person_id ?? existing?.payee_person_id ?? trip.skipper_id;
  if (!payeeId) {
    return { status: "error", message: "Bitte eine Person als Empfänger wählen.", field: "payee_person_id" };
  }
  // Empfänger MUSS Crew dieses Törns sein — die DB erzwingt das nicht
  // (payee_person_id → persons), und an ihn gehen echte Gutschriften.
  if (!(await personsBelongToTrip(supabase, [payeeId], tripId))) {
    return { status: "error", message: CROSS_TRIP_PERSON_MSG, field: "payee_person_id" };
  }

  if (input.category_id) {
    const { data: cat, error: catErr } = await supabase
      .from("trip_categories")
      .select("id")
      .eq("id", input.category_id)
      .eq("trip_id", tripId)
      .maybeSingle();
    if (catErr) return { status: "error", message: dbErr(catErr, "Kategorie konnte nicht geprüft werden.") };
    if (!cat) {
      return { status: "error", message: "Die Kategorie gehört nicht zu diesem Törn. Bitte Seite neu laden.", field: "category_id" };
    }
  }

  // Soll berechnen.
  let members: ItemMember[];
  if (input.split_type === "individuell") {
    const ids = input.obligations.map((o) => o.person_id);
    if (new Set(ids).size !== ids.length) {
      return { status: "error", message: "Eine Person ist doppelt eingetragen.", field: "obligations" };
    }
    if (!(await personsBelongToTrip(supabase, ids, tripId))) {
      return { status: "error", message: CROSS_TRIP_PERSON_MSG, field: "obligations" };
    }
    members = input.obligations.map((o) => ({ personId: o.person_id, days: 0, manualAmount: o.amount }));
  } else {
    // Fail-loud: ohne Crew würde calculateItemObligations scheitern, ein
    // verschluckter Fehler sähe aber aus wie „niemand eingetragen".
    const membersRes = await supabase
      .from("trip_members")
      .select("person_id, on_board_from, on_board_to")
      .eq("trip_id", tripId);
    if (membersRes.error) return { status: "error", message: dbErr(membersRes.error, "Mitglieder konnten nicht geladen werden.") };
    members = (membersRes.data ?? []).map((m) => ({
      personId: m.person_id as string,
      days: daysBetween(m.on_board_from ?? trip.start_date, m.on_board_to ?? trip.end_date),
    }));
  }
  const calc = calculateItemObligations(input.split_type, input.total_amount, members);
  if (!calc.ok) return { status: "error", message: calc.message, field: "total_amount" };
  const shares = calc.shares;

  let oldObligations: ItemShare[] = [];
  const payeeChanged = !!existing && existing.payee_person_id !== payeeId;
  // Nur Metadaten speichern (Soll unangetastet lassen)? Gilt, sobald eine
  // Anbieter-Zahlung existiert und Betrag + Aufteilung (+ bei individuell die
  // Einzelbeträge) unverändert sind. Grill-Fund P1-2: bei gleichmäßig/
  // zeitanteilig würde ein Neuberechnen aus der AKTUELLEN Crew sonst nach
  // jeder Crew-/Datumsänderung ein „anderes" Soll ergeben — und damit selbst
  // eine reine Umbenennung sperren.
  let keepObligations = false;
  if (existing) {
    const obl = await loadObligations(supabase, tripId, existing.id);
    if (!obl.ok) return { status: "error", message: obl.message };
    oldObligations = obl.rows;

    const provider = await loadProviderPayments(supabase, tripId, existing.id);
    if (!provider.ok) return { status: "error", message: provider.message };
    if (provider.rows.length > 0) {
      const distributionChanged =
        Math.round(existing.total_amount * 100) !== Math.round(input.total_amount * 100) ||
        existing.split_type !== input.split_type ||
        (input.split_type === "individuell" && sollSignature(oldObligations) !== sollSignature(shares));
      keepObligations = true;
      if (distributionChanged) {
        return {
          status: "error",
          message:
            "Für diesen Posten ist schon eine Zahlung an den Anbieter gebucht. Betrag und Aufteilung lassen sich " +
            "danach nicht mehr ändern. Lösche zuerst die Anbieter-Zahlung in der Buchungsliste und erfasse sie nach " +
            "der Änderung neu.",
          field: "total_amount",
        };
      }
      if (payeeChanged) {
        return {
          status: "error",
          message:
            "Für diesen Posten hat der bisherige Empfänger schon an den Anbieter gezahlt. Der Empfänger lässt " +
            "sich deshalb nicht mehr wechseln.",
          field: "payee_person_id",
        };
      }
    }
  }

  const baseRow = {
    category_id: input.category_id ?? null,
    label: input.label,
    total_amount: input.total_amount,
    due_date: input.due_date || null,
    split_type: input.split_type,
    sort_order: input.sort_order,
  };
  const obligationRows = shares.map((s) => ({ item_id: itemId, trip_id: tripId, person_id: s.personId, amount: s.amount }));

  // ── Writes ────────────────────────────────────────────────────────────
  if (!existing) {
    const { error: insErr } = await supabase
      .from("prepayment_items")
      .insert({ id: itemId, trip_id: tripId, payee_person_id: payeeId, ...baseRow });
    if (insErr) {
      // Paralleler Zweitversuch mit derselben ID: der erste hat gewonnen.
      if (insErr.code === PG_UNIQUE_VIOLATION) {
        return { status: "error", message: "Der Posten wird gerade schon gespeichert. Bitte Seite neu laden." };
      }
      return { status: "error", message: itemDbErrorMessage(insErr, "Posten konnte nicht gespeichert werden.") };
    }
    const { error: oblErr } = await supabase.from("prepayment_item_obligations").insert(obligationRows);
    if (oblErr) {
      // Rollback: ein Posten ohne Soll wäre in der Matrix ein „alles bezahlt".
      const { error: rbErr } = await supabase.from("prepayment_items").delete().eq("id", itemId).eq("trip_id", tripId);
      if (rbErr) console.error("[bordkasse:db] saveItem rollback:", rbErr.message);
      const msg = dbErr(oblErr, "Sollbeträge konnten nicht gespeichert werden.");
      return { status: "error", message: rbErr ? `${msg} ${ROLLBACK_FAILED_SUFFIX}` : msg };
    }
  } else {
    // Kompensierende Rücksetzer — liefern `false`, wenn das Zurücksetzen
    // selbst scheitert (Grill-Fund P3-13: das darf nicht nur im Log stehen).
    const restoreItem = async (): Promise<boolean> => {
      const { error } = await supabase
        .from("prepayment_items")
        .update({
          category_id: existing.category_id,
          label: existing.label,
          total_amount: existing.total_amount,
          due_date: existing.due_date,
          split_type: existing.split_type,
          sort_order: existing.sort_order,
        })
        .eq("id", existing.id)
        .eq("trip_id", tripId);
      if (error) console.error("[bordkasse:db] saveItem restoreItem:", error.message);
      return !error;
    };
    const restoreObligations = async (): Promise<boolean> => {
      const del = await supabase.from("prepayment_item_obligations").delete().eq("item_id", existing.id).eq("trip_id", tripId);
      if (del.error) {
        console.error("[bordkasse:db] saveItem restoreObligations/delete:", del.error.message);
        return false;
      }
      if (oldObligations.length === 0) return true;
      const ins = await supabase.from("prepayment_item_obligations").insert(
        oldObligations.map((o) => ({ item_id: existing.id, trip_id: tripId, person_id: o.personId, amount: o.amount })),
      );
      if (ins.error) console.error("[bordkasse:db] saveItem restoreObligations/insert:", ins.error.message);
      return !ins.error;
    };
    const rollbackAll = async (message: string): Promise<ItemActionState> => {
      const okObl = keepObligations ? true : await restoreObligations();
      const okItem = await restoreItem();
      return {
        status: "error",
        message: okObl && okItem ? message : `${message} ${ROLLBACK_FAILED_SUFFIX}`,
      };
    };

    const { error: updErr } = await supabase
      .from("prepayment_items")
      .update(baseRow)
      .eq("id", existing.id)
      .eq("trip_id", tripId);
    if (updErr) return { status: "error", message: itemDbErrorMessage(updErr, "Posten konnte nicht gespeichert werden.") };

    if (!keepObligations) {
      const { error: delErr } = await supabase
        .from("prepayment_item_obligations")
        .delete()
        .eq("item_id", existing.id)
        .eq("trip_id", tripId);
      if (delErr) {
        const okItem = await restoreItem();
        const msg = dbErr(delErr, "Sollbeträge konnten nicht gespeichert werden.");
        return { status: "error", message: okItem ? msg : `${msg} ${ROLLBACK_FAILED_SUFFIX}` };
      }
      const { error: insErr } = await supabase.from("prepayment_item_obligations").insert(obligationRows);
      if (insErr) return rollbackAll(dbErr(insErr, "Sollbeträge konnten nicht gespeichert werden."));

      // Race-Schutz (Grill-Fund P2-6): ist WÄHREND des Neuverteilens eine
      // Anbieter-Zahlung gebucht worden, wurde sie nach dem alten (oder
      // gerade gelöschten) Soll verteilt — das neue Soll passte nicht mehr zu
      // ihren per_person-Anteilen. Dann lieber zurückrollen.
      const recheck = await loadProviderPayments(supabase, tripId, existing.id);
      if (!recheck.ok) return rollbackAll(recheck.message);
      if (recheck.rows.length > 0 && !(await providerSharesMatchSoll(supabase, recheck.rows, shares))) {
        return rollbackAll(
          "Während des Speicherns wurde eine Zahlung an den Anbieter gebucht. Bitte Seite neu laden und erneut versuchen.",
        );
      }
    }

    // Empfängerwechsel zuletzt: atomar in SQL (Posten + credit_to in einer
    // Transaktion, 0059). Scheitert er, wird der Rest zurückgerollt — sonst
    // stünde ein geänderter Posten mit dem alten Empfänger da, ohne dass der
    // Nutzer das merkt.
    if (payeeChanged) {
      const { error: moveErr } = await supabase.rpc("move_item_payee", {
        p_item_id: existing.id,
        p_new_payee: payeeId,
      });
      if (moveErr) return rollbackAll(itemDbErrorMessage(moveErr, "Empfänger konnte nicht gewechselt werden."));
    }
  }

  await logAudit(supabase, {
    table_name: "prepayment_items",
    operation: existing ? "UPDATE" : "INSERT",
    record_id: itemId,
    trip_id: tripId,
    actor_person_id: person.id,
    // Bewusst ohne Bezeichnung (Freitext) — Audit ohne Klartext (PR 7, Punkt 4).
    payload: {
      split_type: input.split_type,
      total_amount: input.total_amount,
      n_obligations: shares.length,
      payee_changed: payeeChanged,
    },
  });

  // Ein Empfängerwechsel hängt credit_to um → v_balances ändert sich.
  if (payeeChanged) await markPostSettlementChange(supabase, tripId);
  revalidateItemPaths(tripId, { balance: payeeChanged });
  revalidatePath(`/trips/${tripId}/settings`);
  return { status: "ok", itemId };
}

// ────────────────────────────────────────────────────────────────────────
// 2. Posten löschen
// ────────────────────────────────────────────────────────────────────────

/**
 * Löscht einen Posten. Semantik aus 0058 (Trigger pi_guard_delete):
 *   • bestätigte Zahlungen (Gutschrift ODER Anbieter-Ausgabe) → blocken.
 *     `ON DELETE SET NULL` ließe sie sonst still in die Bordkasse kippen.
 *   • offene Selbstmeldungen → blocken mit Hinweis, sie erst zu bestätigen
 *     oder abzulehnen. Bewusst KEIN automatisches Ablehnen: das wäre eine
 *     Entscheidung über fremdes Geld, die der Empfänger treffen soll.
 *   • soft-gelöschte Zeilen → harmlos, der FK entkoppelt sie (die
 *     tx_credit_self-Ausnahme für deleted_at macht das möglich).
 * Die App prüft vorab für eine verständliche Meldung; der Trigger bleibt der
 * Schutz gegen ein Race zwischen Prüfung und DELETE (Meldung gemappt).
 * Das Soll verschwindet per CASCADE mit.
 */
export async function deleteItem(_prev: ItemActionState, formData: FormData): Promise<ItemActionState> {
  const person = await getCurrentPerson();
  if (!person) return { status: "error", message: "Nicht angemeldet." };

  const parsed = DeleteItemSchema.safeParse({ trip_id: formData.get("trip_id"), item_id: formData.get("item_id") });
  if (!parsed.success) return { status: "error", message: "Ungültige Eingabe." };
  const { trip_id: tripId, item_id: itemId } = parsed.data;

  const auth = await requireSkipperOrAdmin(tripId);
  if (!auth.ok) return { status: "error", message: auth.message };

  const supabase = createAdminClient();
  const archivedCheck = await assertTripNotArchived(supabase, tripId);
  if (!archivedCheck.ok) return { status: "error", message: archivedCheck.message };

  const loaded = await loadItem(supabase, tripId, itemId);
  if (!loaded.ok) return { status: "error", message: loaded.message };

  const [confirmedRes, pendingRes] = await Promise.all([
    supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("trip_id", tripId)
      .eq("item_id", itemId)
      .is("deleted_at", null)
      .not("confirmed_at", "is", null),
    supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("trip_id", tripId)
      .eq("item_id", itemId)
      .is("deleted_at", null)
      .is("confirmed_at", null),
  ]);
  if (confirmedRes.error || pendingRes.error) {
    return {
      status: "error",
      message: dbErr(confirmedRes.error ?? pendingRes.error, "Zahlungen konnten nicht geprüft werden."),
    };
  }
  if ((confirmedRes.count ?? 0) > 0) {
    return {
      status: "error",
      message:
        "An diesem Posten hängen bereits bestätigte Zahlungen. Er kann nicht gelöscht werden — " +
        "lösche zuerst die Zahlungen in der Buchungsliste, falls sie falsch erfasst wurden.",
    };
  }
  if ((pendingRes.count ?? 0) > 0) {
    return {
      status: "error",
      message: "An diesem Posten hängt noch eine unbestätigte Selbstmeldung. Bitte erst bestätigen oder ablehnen.",
    };
  }

  const { error } = await supabase.from("prepayment_items").delete().eq("id", itemId).eq("trip_id", tripId);
  if (error) return { status: "error", message: itemDbErrorMessage(error, "Posten konnte nicht gelöscht werden.") };

  await logAudit(supabase, {
    table_name: "prepayment_items",
    operation: "DELETE",
    record_id: itemId,
    trip_id: tripId,
    actor_person_id: person.id,
    payload: { total_amount: loaded.item.total_amount },
  });

  revalidateItemPaths(tripId);
  revalidatePath(`/trips/${tripId}/settings`);
  return { status: "ok", itemId };
}

// ────────────────────────────────────────────────────────────────────────
// 3. Crew-Zahlung erfassen (Crew → Empfänger), sofort bestätigt
// ────────────────────────────────────────────────────────────────────────

/**
 * Empfänger, Skipper oder Admin trägt ein, dass eine Person ihren Anteil an
 * den Empfänger gezahlt hat. Gutschrift mit `item_id`, `credit_to` =
 * Empfänger (aus dem Posten, NIE aus dem Formular), sofort bestätigt.
 * Zahlt der Empfänger selbst, entsteht eine Selbstverrechnung (bilanzneutral).
 *
 * Kein `:overflow`-Split wie bei recordPayment: ein Posten hat keine zweite
 * Tranche, auf die ein Überschuss umgebucht werden könnte. Eine Überzahlung
 * bleibt im Posten-Topf und wird als „überzahlt" angezeigt — der einzige
 * Insert ist über `idempotency_key` (UNIQUE trip_id+key, 0005) dedupliziert,
 * ein abgeleiteter Zweitschlüssel ist daher nicht nötig.
 */
export async function recordItemPayment(_prev: ItemActionState, formData: FormData): Promise<ItemActionState> {
  const person = await getCurrentPerson();
  if (!person) return { status: "error", message: "Nicht angemeldet." };

  const parsed = RecordItemPaymentSchema.safeParse({
    trip_id: formData.get("trip_id"),
    item_id: formData.get("item_id"),
    person_id: formData.get("person_id"),
    amount: formData.get("amount"),
    date: formData.get("date"),
    note: formData.get("note") || "",
    idempotency_key: formData.get("idempotency_key") || undefined,
  });
  if (!parsed.success) return { status: "error", ...zodMessage(parsed.error) };
  const { trip_id: tripId, item_id: itemId, person_id: payerId, amount, date, note, idempotency_key } = parsed.data;

  const auth = await requireSkipperAdminOrItemPayee(itemId);
  if (!auth.ok) return { status: "error", message: auth.message };
  if (auth.tripId !== tripId) return { status: "error", message: ITEM_FOREIGN_MSG };

  const supabase = createAdminClient();
  const archivedCheck = await assertTripNotArchived(supabase, tripId);
  if (!archivedCheck.ok) return { status: "error", message: archivedCheck.message };

  if (!(await itemBelongsToTrip(supabase, itemId, tripId))) return { status: "error", message: ITEM_FOREIGN_MSG };
  if (!(await personsBelongToTrip(supabase, [payerId], tripId))) {
    return { status: "error", message: CROSS_TRIP_PERSON_MSG, field: "person_id" };
  }
  const loaded = await loadItem(supabase, tripId, itemId);
  if (!loaded.ok) return { status: "error", message: loaded.message };

  const { data: tx, error } = await supabase.from("transactions").insert({
    trip_id: tripId,
    type: "credit",
    date,
    description: note || `Posten ${loaded.item.label}`,
    amount,
    credit_from: payerId,
    credit_to: loaded.item.payee_person_id,
    credit_to_all: false,
    item_id: itemId,
    created_by: person.id,
    confirmed_at: new Date().toISOString(),
    idempotency_key,
  }).select("id").single();
  if (error?.code === PG_UNIQUE_VIOLATION && idempotency_key) {
    // Retry desselben Submits — die Zahlung ist schon gebucht.
    if (!(await isSameItemBooking(supabase, tripId, idempotency_key, { itemId, type: "credit" }))) {
      return { status: "error", message: "Diese Zahlung wurde schon unter einer anderen Buchung gespeichert. Bitte Seite neu laden." };
    }
    revalidateItemPaths(tripId, { balance: true });
    return { status: "ok", itemId, duplicate: true };
  }
  if (error || !tx) return { status: "error", message: itemDbErrorMessage(error, "Zahlung konnte nicht erfasst werden.") };

  await logAudit(supabase, {
    table_name: "transactions",
    operation: "INSERT",
    record_id: tx.id,
    trip_id: tripId,
    actor_person_id: person.id,
    // Keine Notiz (Freitext) im Audit-Log.
    payload: { kind: "item-payment", item_id: itemId, person_id: payerId, amount },
  });

  await markPostSettlementChange(supabase, tripId);
  revalidateItemPaths(tripId, { balance: true });
  return { status: "ok", itemId };
}

// ────────────────────────────────────────────────────────────────────────
// 4. Crew-Selbstmeldung → Bestätigung / Ablehnung
// ────────────────────────────────────────────────────────────────────────

/**
 * Crewmitglied meldet „Ich habe meinen Anteil gezahlt" — Gutschrift mit
 * `confirmed_at = NULL` (pending), `credit_from` = die meldende Person
 * selbst (nie aus dem Formular), `credit_to` = Empfänger des Postens.
 * Zählt erst nach Bestätigung (v_prepayment_item_payments filtert, und
 * v_balances / v_balances_bordkasse_only ignorieren Pending).
 */
export async function submitItemSelfPayment(_prev: ItemActionState, formData: FormData): Promise<ItemActionState> {
  const person = await getCurrentPerson();
  if (!person) return { status: "error", message: "Nicht angemeldet." };

  const parsed = SubmitItemSelfPaymentSchema.safeParse({
    trip_id: formData.get("trip_id"),
    item_id: formData.get("item_id"),
    amount: formData.get("amount"),
    date: formData.get("date"),
    note: formData.get("note") || "",
    idempotency_key: formData.get("idempotency_key") || undefined,
  });
  if (!parsed.success) return { status: "error", ...zodMessage(parsed.error) };
  const { trip_id: tripId, item_id: itemId, amount, date, note, idempotency_key } = parsed.data;

  const auth = await requireMember(tripId);
  if (!auth.ok) return { status: "error", message: auth.message };

  const supabase = createAdminClient();
  const archivedCheck = await assertTripNotArchived(supabase, tripId);
  if (!archivedCheck.ok) return { status: "error", message: archivedCheck.message };

  if (!(await itemBelongsToTrip(supabase, itemId, tripId))) return { status: "error", message: ITEM_FOREIGN_MSG };
  const loaded = await loadItem(supabase, tripId, itemId);
  if (!loaded.ok) return { status: "error", message: loaded.message };

  const { data: tx, error } = await supabase
    .from("transactions")
    .insert({
      trip_id: tripId,
      type: "credit",
      date,
      description: note || `Posten ${loaded.item.label} (selbst gemeldet)`,
      amount,
      credit_from: auth.personId,
      credit_to: loaded.item.payee_person_id,
      credit_to_all: false,
      item_id: itemId,
      created_by: auth.personId,
      confirmed_at: null, // ← pending
      idempotency_key,
    })
    .select("id")
    .single();
  if (error?.code === PG_UNIQUE_VIOLATION && idempotency_key) {
    if (!(await isSameItemBooking(supabase, tripId, idempotency_key, { itemId, type: "credit" }))) {
      return { status: "error", message: "Diese Meldung wurde schon unter einer anderen Buchung gespeichert. Bitte Seite neu laden." };
    }
    revalidateItemPaths(tripId);
    return { status: "ok", itemId, duplicate: true };
  }
  if (error || !tx) return { status: "error", message: itemDbErrorMessage(error, "Meldung konnte nicht gespeichert werden.") };

  await logAudit(supabase, {
    table_name: "transactions",
    operation: "INSERT",
    record_id: tx.id,
    trip_id: tripId,
    actor_person_id: auth.personId,
    payload: { kind: "item-self-payment-pending", item_id: itemId, amount },
  });

  // Pending ändert keine Bilanz → kein markPostSettlementChange.
  revalidateItemPaths(tripId);
  return { status: "ok", itemId };
}

const ItemTxSchema = z.object({ transaction_id: z.string().uuid() });

/** Lädt eine offene Posten-Selbstmeldung + prüft die Rolle für ihren Posten. */
async function loadPendingItemCredit(
  formData: FormData,
): Promise<
  | {
      ok: true;
      supabase: AdminClient;
      actorId: string;
      tx: { id: string; trip_id: string; item_id: string; amount: number };
    }
  | { ok: false; message: string }
> {
  const parsed = ItemTxSchema.safeParse({ transaction_id: formData.get("transaction_id") });
  if (!parsed.success) return { ok: false, message: "Ungültige Buchungs-ID." };

  const supabase = createAdminClient();
  const { data: tx, error } = await supabase
    .from("transactions")
    .select("id, trip_id, item_id, type, amount, confirmed_at, deleted_at")
    .eq("id", parsed.data.transaction_id)
    .maybeSingle();
  if (error) return { ok: false, message: dbErr(error, "Buchung konnte nicht geladen werden.") };
  if (!tx || tx.deleted_at) return { ok: false, message: "Buchung nicht gefunden." };
  if (tx.type !== "credit" || !tx.item_id) return { ok: false, message: "Keine Posten-Zahlung." };
  if (tx.confirmed_at) return { ok: false, message: "Schon bestätigt." };

  // Rolle am Posten der Buchung — nicht an einem Formularwert.
  const auth = await requireSkipperAdminOrItemPayee(tx.item_id);
  if (!auth.ok) return { ok: false, message: auth.message };
  if (auth.tripId !== tx.trip_id) return { ok: false, message: ITEM_FOREIGN_MSG };

  const archivedCheck = await assertTripNotArchived(supabase, tx.trip_id);
  if (!archivedCheck.ok) return { ok: false, message: archivedCheck.message };

  return {
    ok: true,
    supabase,
    actorId: auth.personId,
    tx: { id: tx.id, trip_id: tx.trip_id, item_id: tx.item_id, amount: Number(tx.amount) },
  };
}

/** Empfänger/Skipper/Admin bestätigt eine Selbstmeldung → zählt ab jetzt. */
export async function confirmItemSelfPayment(_prev: ItemActionState, formData: FormData): Promise<ItemActionState> {
  const person = await getCurrentPerson();
  if (!person) return { status: "error", message: "Nicht angemeldet." };

  const loaded = await loadPendingItemCredit(formData);
  if (!loaded.ok) return { status: "error", message: loaded.message };
  const { supabase, tx, actorId } = loaded;

  // `.is("confirmed_at", null)` + `.is("deleted_at", null)`: ein parallel
  // abgelehnter oder schon bestätigter Eintrag wird nicht (erneut) bestätigt.
  const { data: updated, error } = await supabase
    .from("transactions")
    .update({ confirmed_at: new Date().toISOString() })
    .eq("id", tx.id)
    .eq("trip_id", tx.trip_id)
    .is("confirmed_at", null)
    .is("deleted_at", null)
    .select("id");
  if (error) return { status: "error", message: itemDbErrorMessage(error, "Bestätigung fehlgeschlagen.") };
  if (!updated || updated.length === 0) {
    return { status: "error", message: "Diese Meldung wurde inzwischen schon bearbeitet. Bitte Seite neu laden." };
  }

  await logAudit(supabase, {
    table_name: "transactions",
    operation: "UPDATE",
    record_id: tx.id,
    trip_id: tx.trip_id,
    actor_person_id: actorId,
    payload: { kind: "item-self-payment-confirmed", item_id: tx.item_id },
  });

  await markPostSettlementChange(supabase, tx.trip_id);
  revalidateItemPaths(tx.trip_id, { balance: true });
  return { status: "ok", itemId: tx.item_id };
}

/**
 * Empfänger/Skipper/Admin lehnt eine Selbstmeldung ab → Soft-Delete
 * (deleted_at). Die Person sieht ihren Anteil danach wieder als offen.
 */
export async function rejectItemSelfPayment(_prev: ItemActionState, formData: FormData): Promise<ItemActionState> {
  const person = await getCurrentPerson();
  if (!person) return { status: "error", message: "Nicht angemeldet." };

  const loaded = await loadPendingItemCredit(formData);
  if (!loaded.ok) {
    return {
      status: "error",
      message: loaded.message === "Schon bestätigt." ? "Schon bestätigt, kann nicht mehr abgelehnt werden." : loaded.message,
    };
  }
  const { supabase, tx, actorId } = loaded;

  const { data: updated, error } = await supabase
    .from("transactions")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", tx.id)
    .eq("trip_id", tx.trip_id)
    .is("confirmed_at", null)
    .is("deleted_at", null)
    .select("id");
  if (error) return { status: "error", message: itemDbErrorMessage(error, "Ablehnen fehlgeschlagen.") };
  if (!updated || updated.length === 0) {
    return { status: "error", message: "Diese Meldung wurde inzwischen schon bearbeitet. Bitte Seite neu laden." };
  }

  await logAudit(supabase, {
    table_name: "transactions",
    operation: "DELETE",
    record_id: tx.id,
    trip_id: tx.trip_id,
    actor_person_id: actorId,
    payload: { kind: "item-self-payment-rejected", item_id: tx.item_id },
  });

  // Pending zählte nirgends → Bilanz unverändert, kein Settlement-Marker.
  revalidateItemPaths(tx.trip_id);
  return { status: "ok", itemId: tx.item_id };
}

// ────────────────────────────────────────────────────────────────────────
// 5. Anbieter-Zahlung (Empfänger → Airline/Bahn)
// ────────────────────────────────────────────────────────────────────────

/**
 * Bucht die reale Zahlung des Empfängers an den Anbieter: Ausgabe mit
 * `item_id`, `paid_by` = Empfänger des Postens (NIE aus dem Formular —
 * sonst stünde die Zahlung bei jemandem, an den die Crew nichts überweist),
 * Kategorie des Postens, Aufteilung `per_person` mit den Soll-Beträgen
 * (allocateItemProviderShares, kumulativ bei Teilzahlungen).
 *
 * Warum per_person statt equal/time_proportional: siehe
 * lib/calc/prepayment-item-shares.ts — nur so ist die Gesamtbilanz jeder
 * Person 0, sobald alle ihr Soll gezahlt haben (Review-Fund Bilanz, PR 270).
 *
 * Σ Anbieter-Zahlungen darf die Posten-Summe nicht übersteigen: ein Rest
 * über dem Soll hätte keine Gegenseite (niemand schuldet ihn) und bliebe als
 * dauerhafter Saldo stehen. Teurer geworden → Posten-Betrag erhöhen (geht,
 * solange noch keine Anbieter-Zahlung gebucht ist).
 */
export async function recordItemProviderPayment(
  _prev: ItemActionState,
  formData: FormData,
): Promise<ItemActionState> {
  const person = await getCurrentPerson();
  if (!person) return { status: "error", message: "Nicht angemeldet." };

  const parsed = RecordItemProviderPaymentSchema.safeParse({
    trip_id: formData.get("trip_id"),
    item_id: formData.get("item_id"),
    amount: formData.get("amount"),
    date: formData.get("date"),
    description: formData.get("description") || "",
    idempotency_key: formData.get("idempotency_key") || undefined,
  });
  if (!parsed.success) return { status: "error", ...zodMessage(parsed.error) };
  const { trip_id: tripId, item_id: itemId, amount, date, description, idempotency_key } = parsed.data;

  const auth = await requireSkipperAdminOrItemPayee(itemId);
  if (!auth.ok) return { status: "error", message: auth.message };
  if (auth.tripId !== tripId) return { status: "error", message: ITEM_FOREIGN_MSG };

  const supabase = createAdminClient();
  const archivedCheck = await assertTripNotArchived(supabase, tripId);
  if (!archivedCheck.ok) return { status: "error", message: archivedCheck.message };

  if (!(await itemBelongsToTrip(supabase, itemId, tripId))) return { status: "error", message: ITEM_FOREIGN_MSG };
  const loaded = await loadItem(supabase, tripId, itemId);
  if (!loaded.ok) return { status: "error", message: loaded.message };
  const item = loaded.item;

  // Der Empfänger muss Crew sein, sonst fiele seine Ausgabe aus v_balances.
  if (!(await personsBelongToTrip(supabase, [item.payee_person_id], tripId))) {
    return { status: "error", message: CROSS_TRIP_PERSON_MSG };
  }

  const [obl, provider] = await Promise.all([
    loadObligations(supabase, tripId, itemId),
    loadProviderPayments(supabase, tripId, itemId),
  ]);
  if (!obl.ok) return { status: "error", message: obl.message };
  if (!provider.ok) return { status: "error", message: provider.message };

  const alreadyPaid = provider.rows.reduce((s, r) => s + r.amount, 0);
  if (alreadyPaid + amount > item.total_amount + 0.005) {
    const open = Math.max(0, item.total_amount - alreadyPaid);
    return {
      status: "error",
      message: `Das übersteigt den Betrag des Postens. Noch offen beim Anbieter: ${open.toFixed(2).replace(".", ",")} €.`,
      field: "amount",
    };
  }

  // Bisher vergebene Anteile (für die kumulative Verteilung).
  let already: ItemShare[] = [];
  if (provider.rows.length > 0) {
    const { data: parts, error: partsErr } = await supabase
      .from("transaction_participants")
      .select("person_id, amount")
      .in("transaction_id", provider.rows.map((r) => r.id));
    if (partsErr) return { status: "error", message: dbErr(partsErr, "Bisherige Anteile konnten nicht geladen werden.") };
    already = (parts ?? []).map((p) => ({ personId: p.person_id as string, amount: Number(p.amount ?? 0) }));
  }

  const shares = allocateItemProviderShares(amount, obl.rows, already);
  if (shares.length === 0) {
    return { status: "error", message: "Für diesen Posten ist noch kein Soll verteilt. Bitte den Posten zuerst speichern." };
  }

  const { data: tx, error } = await supabase
    .from("transactions")
    .insert({
      trip_id: tripId,
      type: "expense",
      date,
      description: description || item.label,
      category_id: item.category_id,
      paid_by: item.payee_person_id,
      amount,
      alcohol_amount: 0,
      tip_amount: 0,
      split_type: "per_person",
      item_id: itemId,
      created_by: person.id,
      idempotency_key,
    })
    .select("id")
    .single();
  if (error?.code === PG_UNIQUE_VIOLATION && idempotency_key) {
    if (!(await isSameItemBooking(supabase, tripId, idempotency_key, { itemId, type: "expense" }))) {
      return { status: "error", message: "Diese Zahlung wurde schon unter einer anderen Buchung gespeichert. Bitte Seite neu laden." };
    }
    revalidateItemPaths(tripId, { balance: true });
    return { status: "ok", itemId, duplicate: true };
  }
  if (error || !tx) return { status: "error", message: itemDbErrorMessage(error, "Zahlung konnte nicht gebucht werden.") };

  // Rollback (Muster createExpense): löscht die Ausgabe wieder (die Anteile
  // per CASCADE) und gibt damit den idempotency_key für einen sauberen Retry
  // frei.
  const rollback = async (message: string): Promise<ItemActionState> => {
    const { error: rbErr } = await supabase.from("transactions").delete().eq("id", tx.id).eq("trip_id", tripId);
    if (rbErr) console.error("[bordkasse:db] recordItemProviderPayment rollback:", rbErr.message);
    return { status: "error", message: rbErr ? `${message} ${ROLLBACK_FAILED_SUFFIX}` : message };
  };

  const { error: partErr } = await supabase
    .from("transaction_participants")
    .insert(shares.map((s) => ({ transaction_id: tx.id, person_id: s.personId, amount: s.amount })));
  if (partErr) {
    // Ohne Anteile wäre die Ausgabe eine per_person-Buchung ohne
    // Verteilung → Σ v_balances ≠ 0.
    return rollback(dbErr(partErr, "Zahlung konnte nicht vollständig gespeichert werden. Bitte erneut versuchen."));
  }

  // Nachkontrolle gegen parallele Schreibzugriffe (Grill-Fund P2-6/P2-7) —
  // es gibt keine Transaktion über die Service-Role-Requests:
  //   • zwei gleichzeitige Anbieter-Zahlungen könnten zusammen die Posten-
  //     Summe übersteigen (jede hat den Deckel einzeln bestanden);
  //   • ein gleichzeitiges saveItem könnte das Soll inzwischen neu verteilt
  //     haben — dann passten diese Anteile nicht mehr zum Soll.
  // In beiden Fällen wird DIESE Zahlung zurückgerollt (im Zweifel beide —
  // fail-safe, ein erneuter Versuch klappt dann).
  const [afterProvider, afterObl] = await Promise.all([
    loadProviderPayments(supabase, tripId, itemId),
    loadObligations(supabase, tripId, itemId),
  ]);
  if (!afterProvider.ok) return rollback(afterProvider.message);
  if (!afterObl.ok) return rollback(afterObl.message);
  if (afterProvider.rows.reduce((s, r) => s + r.amount, 0) > item.total_amount + 0.005) {
    return rollback("Gleichzeitig wurde eine weitere Zahlung an den Anbieter gebucht; zusammen übersteigen sie den Posten. Bitte Seite neu laden.");
  }
  if (sollSignature(afterObl.rows) !== sollSignature(obl.rows)) {
    return rollback("Der Posten wurde gerade geändert. Bitte Seite neu laden und die Zahlung erneut erfassen.");
  }

  await logAudit(supabase, {
    table_name: "transactions",
    operation: "INSERT",
    record_id: tx.id,
    trip_id: tripId,
    actor_person_id: person.id,
    payload: { kind: "item-provider-payment", item_id: itemId, amount, n_shares: shares.length },
  });

  await markPostSettlementChange(supabase, tripId);
  revalidateItemPaths(tripId, { balance: true });
  revalidatePath(`/trips/${tripId}/debts`);
  return { status: "ok", itemId };
}
