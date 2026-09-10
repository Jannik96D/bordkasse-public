"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { requireSkipperOrAdmin, requireMember, requireSkipperAdminOrAdvancer } from "@/lib/auth/authz";
import { assertTripNotArchived } from "@/lib/auth/trip-state";
import { sendPushToPersons } from "@/lib/notify/web-push";
import { pushRecipients } from "@/lib/notify/recipients";
import { paymentPendingPush, paymentConfirmedPush, paymentRejectedPush } from "@/lib/notify/payloads";
import {
  personsBelongToTrip,
  trancheBelongsToTrip,
  personHasBookingTrace,
  CROSS_TRIP_PERSON_MSG,
} from "@/lib/auth/cross-trip";
import { logAudit } from "@/lib/db/audit";
import {
  PlanSchema,
  TranchesSchema,
  RecordPaymentSchema,
  ReplaceMemberSchema,
} from "@/lib/validation/prepayment-schema";
import { calculateObligations } from "@/lib/calc/prepayment-shares";
import type { PrepaymentMember, PrepaymentCabin } from "@/lib/calc/prepayment-shares";
import { sendInvitationMagicLink } from "@/lib/auth/invite";
import { resolveOrigin, appOrigin } from "@/lib/auth/origin";
import { round2, daysBetween, displayNameFromEmail } from "@/lib/utils";

const PG_UNIQUE_VIOLATION = "23505";

export type PrepaymentState =
  | { status: "idle" }
  | { status: "ok" }
  | { status: "error"; message: string; field?: string };

function dbErr(err: { message: string } | null, fallback: string): string {
  if (err?.message) console.error("[bordkasse:db]", err.message);
  return fallback;
}

// ────────────────────────────────────────────────────────────────────────
// 1. Plan + Kojen + Soll-Verteilung speichern
// ────────────────────────────────────────────────────────────────────────

/**
 * Erwartet ein JSON-Payload im `payload`-Feld (Form-Submit über Hidden-Input).
 * Berechnet ggf. Obligations automatisch aus Aufteilungsmethode + Trip-Crew.
 */
export async function savePrepaymentPlan(
  _prev: PrepaymentState,
  formData: FormData,
): Promise<PrepaymentState> {
  const person = await getCurrentPerson();
  if (!person) return { status: "error", message: "Nicht angemeldet." };

  const raw = formData.get("payload");
  if (typeof raw !== "string") {
    return { status: "error", message: "Payload fehlt." };
  }
  let json: unknown;
  try { json = JSON.parse(raw); } catch {
    return { status: "error", message: "Ungültiges Payload-JSON." };
  }
  const parsed = PlanSchema.safeParse(json);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe." };
  }

  const { trip_id, split_method, total_amount, advancer_person_id, wero_id, whatsapp_template, cabin_types, obligations } = parsed.data;

  const auth = await requireSkipperOrAdmin(trip_id);
  if (!auth.ok) return { status: "error", message: auth.message };

  const supabase = createAdminClient();

  const archivedCheck = await assertTripNotArchived(supabase, trip_id);
  if (!archivedCheck.ok) return { status: "error", message: archivedCheck.message };

  // Cross-Trip-Schutz (Fund 7, Code-Review 2026-08): advancer_person_id kommt
  // aus dem Client-JSON und wurde bisher nur als UUID-Format geprüft (Zod),
  // NICHT gegen die Crew dieses Törns — anders als createExpense/createCredit/
  // recordPayment, die personsBelongToTrip bereits nutzen. recordPayment und
  // submitSelfPayment leiten den Empfänger direkt aus
  // prepayment_plan.advancer_person_id ab und schreiben ihn ungeprüft als
  // credit_to in echte Buchungen — eine trip-fremde Person würde dort landen
  // und zusätzlich Notice-/Reminder-Mails mit Törn-Namen, Beträgen und
  // Crew-Namen erhalten (sendPrepaymentNoticeMails/sendPrepaymentReminderMail
  // nehmen advancerPersonId ungeprüft in die Empfängerliste).
  if (advancer_person_id && !(await personsBelongToTrip(supabase, [advancer_person_id], trip_id))) {
    return { status: "error", message: CROSS_TRIP_PERSON_MSG };
  }

  // Alle Reads, die für die Soll-Berechnung gebraucht werden, laufen VOR dem
  // ersten Write. Ein Lesefehler darf hier nicht erst nach dem Plan-Upsert
  // auffallen: dann trüge die Plan-Zeile schon die neue Methode + Summe,
  // während prepayment_obligations noch die Werte der alten Methode hält —
  // ein Teilzustand, den niemand sieht. Fehler NICHT verschlucken: ohne Crew
  // rechnet calculateObligations reihenweise 0 € Soll, und der Delete+Insert
  // weiter unten überschriebe die echten Sollbeträge damit.
  let members: { person_id: string; on_board_from: string | null; on_board_to: string | null }[] = [];
  let tripRow: { start_date: string; end_date: string } | null = null;
  if (split_method === "gleichmaessig" || split_method === "zeitanteilig") {
    const membersRes = await supabase
      .from("trip_members")
      .select("person_id, on_board_from, on_board_to")
      .eq("trip_id", trip_id);
    if (membersRes.error) {
      return { status: "error", message: dbErr(membersRes.error, "Mitglieder konnten nicht geladen werden.") };
    }
    members = membersRes.data ?? [];
    const tripRes = await supabase
      .from("trips")
      .select("start_date, end_date")
      .eq("id", trip_id)
      .single();
    if (tripRes.error) {
      return { status: "error", message: dbErr(tripRes.error, "Törndaten konnten nicht geladen werden.") };
    }
    tripRow = tripRes.data;
  }

  // 1. Plan-Row upserten
  const { error: planErr } = await supabase
    .from("prepayment_plan")
    .upsert(
      {
        trip_id,
        split_method,
        total_amount,
        advancer_person_id: advancer_person_id || null,
        wero_id: wero_id || null,
        whatsapp_template: whatsapp_template || null,
      },
      { onConflict: "trip_id" },
    );
  if (planErr) return { status: "error", message: dbErr(planErr, "Plan konnte nicht gespeichert werden.") };

  // 2. Kojen — Diff statt Full-Replace, damit FK-Verweise (cabin_type_id in
  //    Obligations) stabil bleiben. Spec: kojen entfernen setzt FK auf NULL.
  // Client generiert UUIDs für neue Kojen (s. Wizard); deshalb haben ALLE
  // eingehenden Kojen eine ID, und wir können einheitlich per UPSERT arbeiten.
  const { data: existingCabins, error: existingCabinsErr } = await supabase
    .from("cabin_types")
    .select("id")
    .eq("trip_id", trip_id);
  // Grill-Review-Fund: ein transienter DB-Fehler hier ließ existingCabinIds
  // fälschlich leer — die Fund-B-Prüfung unten hätte dann JEDE Koje DIESES
  // Törns als "fremd" behandelt (foreignIncomingCabinIds = alle) und den Save
  // dauerhaft mit "gehört nicht zu diesem Törn" blockiert. Fail-loud statt
  // stillem Fallback auf ein leeres Set.
  if (existingCabinsErr) {
    return { status: "error", message: dbErr(existingCabinsErr, "Kojen konnten nicht geladen werden.") };
  }
  const existingCabinIds = new Set((existingCabins ?? []).map((c) => c.id as string));
  const incomingCabinIds = new Set(cabin_types.filter((c) => c.id).map((c) => c.id as string));

  // Fund B (Sanierungsplan PR 9b, IDOR-Schutz): eine eingehende cabin_type_id,
  // die nicht zu DIESEM Törn gehört, könnte trotzdem bereits in der DB
  // existieren — als Koje eines FREMDEN Törns. Der `upsert(..., {onConflict:
  // "id"})` unten würde diese Zeile sonst stillschweigend übernehmen (trip_id/
  // label/Preis/Kapazität überschreiben), weil bisher nur ids DIESES Törns
  // (existingCabinIds) bekannt waren. Global nachschlagen und ablehnen, statt
  // eine fremde Koje zu kapern — analog zum trip_id-Filter bei Tranchen
  // (saveTranches) und den personsBelongToTrip-Checks in dieser Datei.
  const foreignIncomingCabinIds = [...incomingCabinIds].filter((id) => !existingCabinIds.has(id));
  if (foreignIncomingCabinIds.length > 0) {
    const { data: foreignCheck } = await supabase
      .from("cabin_types")
      .select("id")
      .in("id", foreignIncomingCabinIds);
    if ((foreignCheck ?? []).length > 0) {
      return {
        status: "error",
        message: "Eine ausgewählte Koje gehört nicht zu diesem Törn. Bitte Seite neu laden.",
      };
    }
  }

  // Löschen: existierend ABER nicht im Payload
  const toDelete = [...existingCabinIds].filter((id) => !incomingCabinIds.has(id));
  if (toDelete.length > 0) {
    await supabase.from("cabin_types").delete().in("id", toDelete);
  }

  // Upsert: bestehende werden geupdatet, neue mit der vom Client gelieferten
  // UUID neu angelegt — so funktioniert die cabin_type_id-Referenz in den
  // Obligations sofort im selben Submit, ohne Roundtrip.
  if (cabin_types.length > 0) {
    const rows = cabin_types.map((c) => ({
      id: c.id ?? crypto.randomUUID(),
      trip_id,
      label: c.label,
      price_per_person: c.price_per_person,
      capacity: c.capacity,
      sort_order: c.sort_order,
    }));
    const { error: cabinErr } = await supabase
      .from("cabin_types")
      .upsert(rows, { onConflict: "id" });
    if (cabinErr) return { status: "error", message: dbErr(cabinErr, "Kojen konnten nicht gespeichert werden.") };
  }

  // 3. Obligations — Skipper kann via Wizard pro Person setzen (individuell),
  //    oder wir berechnen automatisch aus Methode + Crew.
  //    Bei "kojen" und "individuell" kommt der Input bereits pro Person rein.
  //    Bei "gleichmaessig" und "zeitanteilig" rechnen wir hier.

  let computedObligations = obligations;

  if (split_method === "gleichmaessig" || split_method === "zeitanteilig") {
    const tripStart = tripRow?.start_date ?? "";
    const tripEnd = tripRow?.end_date ?? "";

    const calcMembers: PrepaymentMember[] = members.map((m) => {
      const from = m.on_board_from ?? tripStart;
      const to = m.on_board_to ?? tripEnd;
      const days = daysBetween(from, to);
      return { personId: m.person_id, days };
    });
    const shares = calculateObligations(split_method, total_amount, calcMembers);
    computedObligations = shares.map((s) => ({
      person_id: s.personId,
      total_amount: s.totalAmount,
      cabin_type_id: null,
    }));
  } else if (split_method === "kojen") {
    // Aktuelle Kojen-IDs neu laden (nach Diff)
    // Auch hier fail-loud: ohne Kojen findet calculateObligations für
    // niemanden einen Preis und setzt ALLE Sollbeträge auf 0 (siehe
    // lib/calc/prepayment-shares.ts) — der Delete+Insert unten würde die
    // echten Beträge damit überschreiben.
    const { data: freshCabins, error: freshCabinsErr } = await supabase
      .from("cabin_types")
      .select("id, price_per_person, capacity")
      .eq("trip_id", trip_id);
    if (freshCabinsErr) {
      return {
        status: "error",
        // Anders als die Reads oben lässt sich dieser nicht vorziehen: er braucht
        // die IDs aus dem Kojen-Diff. Plan + Kojen sind hier also schon
        // gespeichert, die Sollbeträge nicht — das muss die Meldung sagen.
        message: dbErr(
          freshCabinsErr,
          "Kojen konnten nicht geladen werden — Plan und Kojen sind gespeichert, die Sollbeträge noch nicht. Bitte erneut speichern.",
        ),
      };
    }
    const cabins: PrepaymentCabin[] = (freshCabins ?? []).map((c) => ({
      id: c.id as string,
      pricePerPerson: Number(c.price_per_person),
      capacity: c.capacity,
    }));
    // Map alte cabin-Labels (für unsaved Kojen kommt cabin_type_id mit alter ID rein)
    // → wenn das Payload eine ID hat, die nicht mehr existiert, setzen wir sie NULL.
    const validIds = new Set(cabins.map((c) => c.id));
    const calcMembers: PrepaymentMember[] = obligations.map((o) => ({
      personId: o.person_id,
      days: 0,
      cabinTypeId: o.cabin_type_id && validIds.has(o.cabin_type_id) ? o.cabin_type_id : null,
    }));
    const shares = calculateObligations("kojen", total_amount, calcMembers, cabins);
    computedObligations = shares.map((s) => ({
      person_id: s.personId,
      total_amount: s.totalAmount,
      cabin_type_id: s.cabinTypeId ?? null,
    }));
  }

  // Cross-Trip-Schutz (Fund 7, Fortsetzung): bei "individuell"/"kojen"
  // kommen die person_id-Werte roh aus dem Client-Payload. "gleichmaessig"/
  // "zeitanteilig" berechnen computedObligations bereits aus trip_members
  // weiter oben und sind damit inhärent trip-scoped — für sie ist dieser
  // Check ein günstiges No-Op. Bewusst NACH dem Berechnen von
  // computedObligations (hängt bei "kojen" von den frisch upgeserteten
  // Kojen-IDs ab), aber VOR dem Schreiben der Sollbeträge.
  if (
    !(await personsBelongToTrip(
      supabase,
      computedObligations.map((o) => o.person_id),
      trip_id,
    ))
  ) {
    return { status: "error", message: CROSS_TRIP_PERSON_MSG };
  }

  // Obligations replace: alte löschen, neue rein.
  await supabase.from("prepayment_obligations").delete().eq("trip_id", trip_id);
  if (computedObligations.length > 0) {
    const rows = computedObligations.map((o) => ({
      trip_id,
      person_id: o.person_id,
      cabin_type_id: o.cabin_type_id ?? null,
      total_amount: o.total_amount,
    }));
    const { error: obErr } = await supabase.from("prepayment_obligations").insert(rows);
    if (obErr) return { status: "error", message: dbErr(obErr, "Sollbeträge konnten nicht gespeichert werden.") };
  }

  // Ein gespeicherter Plan gewinnt immer über eine frühere „ohne Anzahlung"-
  // Entscheidung (trips.prepayment_declined_at, Migration 0040) — sonst
  // blieben CTA + Checklisten-Item trotz existierendem Plan ausgeblendet.
  await supabase
    .from("trips")
    .update({ prepayment_declined_at: null })
    .eq("id", trip_id);

  await logAudit(supabase, {
    table_name: "prepayment_plan",
    operation: "UPDATE",
    record_id: trip_id,
    trip_id,
    actor_person_id: person.id,
    payload: { split_method, total_amount, n_cabins: cabin_types.length, n_obligations: computedObligations.length },
  });

  revalidatePath(`/trips/${trip_id}/prepayments`);
  revalidatePath(`/trips/${trip_id}/balance`);
  revalidatePath(`/trips/${trip_id}`);
  revalidatePath(`/trips/${trip_id}/settings`);
  return { status: "ok" };
}

// ────────────────────────────────────────────────────────────────────────
// 2. Tranchen-Liste speichern
// ────────────────────────────────────────────────────────────────────────

export async function saveTranches(
  _prev: PrepaymentState,
  formData: FormData,
): Promise<PrepaymentState> {
  const person = await getCurrentPerson();
  if (!person) return { status: "error", message: "Nicht angemeldet." };

  const raw = formData.get("payload");
  if (typeof raw !== "string") return { status: "error", message: "Payload fehlt." };
  let json: unknown;
  try { json = JSON.parse(raw); } catch {
    return { status: "error", message: "Ungültiges Payload-JSON." };
  }
  const parsed = TranchesSchema.safeParse(json);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe." };
  }
  const { trip_id, tranches } = parsed.data;

  const auth = await requireSkipperOrAdmin(trip_id);
  if (!auth.ok) return { status: "error", message: auth.message };

  const supabase = createAdminClient();

  const archivedCheck = await assertTripNotArchived(supabase, trip_id);
  if (!archivedCheck.ok) return { status: "error", message: archivedCheck.message };

  // Diff: bestehende IDs vs. eingehende IDs.
  // Löschen einer Tranche setzt zugehörige transactions.tranche_id auf NULL
  // (via ON DELETE SET NULL aus 0023). Die Buchungen wandern dann in den
  // Bordkasse-Pool.
  const { data: existing } = await supabase
    .from("prepayment_tranches")
    .select("id")
    .eq("trip_id", trip_id);
  const existingIds = new Set((existing ?? []).map((t) => t.id as string));
  const incomingIds = new Set(tranches.filter((t) => t.id).map((t) => t.id as string));
  const toDelete = [...existingIds].filter((id) => !incomingIds.has(id));
  if (toDelete.length > 0) {
    // Fund A (Sanierungsplan PR 9b): eine Tranche mit bereits BESTÄTIGTEN
    // Zahlungen darf nicht stillschweigend gelöscht werden. `ON DELETE SET
    // NULL` (0023) würde die betroffenen Buchungen zwar erhalten, sie fallen
    // aber unbemerkt aus dem Anzahlungs-Pool/der Matrix in den Bordkasse-Saldo
    // — niemand bekommt das mit, die Zahlung wirkt danach "verschwunden".
    // Bewusst KEINE DB-Constraint (ON DELETE RESTRICT): der tägliche
    // DSGVO-Purge (0048) verlässt sich auf SET NULL beim Löschen von
    // prepayment_tranches, ein RESTRICT würde den Purge wieder brechen.
    //
    // ⚠️ Grill-Review-Fund: die Prüfung galt ursprünglich nur `type="credit"`
    // (Crew-Zahlungen an den Vorstrecker). Die Charter-Zahlung selbst (Vor-
    // strecker → Vercharterer) ist aber ein `type="expense"` mit derselben
    // `tranche_id` (siehe getCharterPaidTotal/-PerTranche in
    // lib/queries/prepayments.ts) — OHNE den Type-Filter hätte das Löschen
    // einer Tranche mit bereits gezahlter Charter-Rate diese Ausgabe
    // unbemerkt in den Bordkasse-Pool fallen lassen (Split auf die ganze
    // Crew statt Anzahlungs-Soll). Kein Type-Filter mehr — beide Buchungsarten
    // zählen; `confirmed_at` hat für Ausgaben ohnehin `DEFAULT now()`.
    const { count: confirmedCount } = await supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .in("tranche_id", toDelete)
      .not("confirmed_at", "is", null)
      .is("deleted_at", null);
    if ((confirmedCount ?? 0) > 0) {
      return {
        status: "error",
        message:
          "Mindestens eine Tranche hat bereits bestätigte Zahlungen und kann nicht gelöscht werden.",
      };
    }
    await supabase.from("prepayment_tranches").delete().in("id", toDelete);
  }

  for (let i = 0; i < tranches.length; i++) {
    const t = tranches[i];
    const row = {
      trip_id,
      due_date: t.due_date,
      label: t.label,
      percent: t.percent,
      wero_request_link: t.wero_request_link || null,
      sort_order: i,
    };
    // Nur eine bereits zu DIESEM Törn gehörende Tranche aktualisieren — sonst
    // ließe sich über eine untergeschobene Fremd-ID eine Tranche eines anderen
    // Törns überschreiben/übernehmen. Unbekannte IDs werden als Insert behandelt.
    if (t.id && existingIds.has(t.id)) {
      await supabase.from("prepayment_tranches").update(row).eq("id", t.id).eq("trip_id", trip_id);
    } else {
      await supabase.from("prepayment_tranches").insert(row);
    }
  }

  await logAudit(supabase, {
    table_name: "prepayment_tranches",
    operation: "UPDATE",
    record_id: trip_id,
    trip_id,
    actor_person_id: person.id,
    payload: { count: tranches.length },
  });

  revalidatePath(`/trips/${trip_id}/prepayments`);
  return { status: "ok" };
}

// ────────────────────────────────────────────────────────────────────────
// 3. Zahlung erfassen (Crew → Skipper)
// ────────────────────────────────────────────────────────────────────────

export async function recordPayment(
  _prev: PrepaymentState,
  formData: FormData,
): Promise<PrepaymentState> {
  const person = await getCurrentPerson();
  if (!person) return { status: "error", message: "Nicht angemeldet." };

  const parsed = RecordPaymentSchema.safeParse({
    trip_id: formData.get("trip_id"),
    tranche_id: formData.get("tranche_id"),
    person_id: formData.get("person_id"),
    amount: formData.get("amount"),
    date: formData.get("date"),
    note: formData.get("note") || "",
    overflow_tranche_id: formData.get("overflow_tranche_id") || null,
    idempotency_key: formData.get("idempotency_key") || undefined,
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe." };
  }
  const { trip_id, tranche_id, person_id, amount, date, note, overflow_tranche_id, idempotency_key } = parsed.data;

  // Vorstrecker darf auch Zahlungen ankreuzen — er ist Empfänger,
  // weiß also wer ihm Geld überwiesen hat.
  const auth = await requireSkipperAdminOrAdvancer(trip_id);
  if (!auth.ok) return { status: "error", message: auth.message };

  const supabase = createAdminClient();

  const archivedCheck = await assertTripNotArchived(supabase, trip_id);
  if (!archivedCheck.ok) return { status: "error", message: archivedCheck.message };

  // Cross-Trip-Schutz: person_id kommt aus dem Formular (nur als UUID
  // validiert). Der Service-Role-Client umgeht RLS, also hier prüfen, dass
  // die Person wirklich Crew dieses Törns ist — sonst könnte ein Skipper/
  // Vorstrecker eine fremde Person in den Anzahlungspool von trip_id ziehen.
  if (!(await personsBelongToTrip(supabase, [person_id], trip_id))) {
    return { status: "error", message: CROSS_TRIP_PERSON_MSG };
  }

  // Cross-Trip-Schutz auch für die Overflow-Tranche (Fund S-3): die primäre
  // tranche_id wird unten per `.eq("trip_id", trip_id)` geprüft, overflow_tranche_id
  // ging bisher ungeprüft in die zweite Gutschrift und konnte zu einem FREMDEN
  // Törn gehören (kein Composite-FK auf transactions.tranche_id).
  if (overflow_tranche_id && !(await trancheBelongsToTrip(supabase, overflow_tranche_id, trip_id))) {
    return { status: "error", message: "Ungültige Tranche für diesen Törn." };
  }

  // Vorstrecker ermitteln: aus prepayment_plan.advancer_person_id, sonst
  // Trip-Skipper als Fallback. Crewanzahlungen werden gegen diese Person
  // verbucht. Self-Credit (Vorstrecker zahlt seinen eigenen Anteil) ist seit
  // Migration 0024 für tranche-getaggte Gutschriften erlaubt — bilanz-neutral.
  const [{ data: tripRow }, { data: planRow }] = await Promise.all([
    supabase.from("trips").select("skipper_id").eq("id", trip_id).maybeSingle(),
    supabase.from("prepayment_plan").select("advancer_person_id").eq("trip_id", trip_id).maybeSingle(),
  ]);
  if (!tripRow) return { status: "error", message: "Törn nicht gefunden." };
  const advancerId = planRow?.advancer_person_id || tripRow.skipper_id;

  // Soll der Tranche für diese Person berechnen (für Default + Overflow-Check)
  const { data: oblRow } = await supabase
    .from("prepayment_obligations")
    .select("total_amount")
    .eq("trip_id", trip_id)
    .eq("person_id", person_id)
    .maybeSingle();
  const { data: trancheRow } = await supabase
    .from("prepayment_tranches")
    .select("percent, label")
    .eq("id", tranche_id)
    .eq("trip_id", trip_id) // Cross-Trip-Schutz: Tranche muss zu diesem Törn gehören
    .maybeSingle();
  if (!trancheRow) return { status: "error", message: "Tranche nicht gefunden." };

  const trancheLabel = trancheRow.label;
  const trancheSoll = Number(oblRow?.total_amount ?? 0) * Number(trancheRow.percent) / 100;

  // Bereits gezahlt — NUR bestätigte Zahlungen zählen (Fund C, Sanierungsplan
  // PR 9b). Ohne den confirmed_at-Filter würde eine noch unbestätigte
  // Selbstmeldung (submitSelfPayment, confirmed_at = NULL) hier bereits als
  // "bezahlt" mitgezählt, bevor der Skipper sie überhaupt bestätigt hat —
  // "open" (offener Betrag) wäre künstlich zu niedrig, und ein legitimer
  // Overflow-Split würde falsch berechnet.
  const { data: paidRows } = await supabase
    .from("transactions")
    .select("amount")
    .eq("trip_id", trip_id)
    .eq("tranche_id", tranche_id)
    .eq("credit_from", person_id)
    .eq("type", "credit")
    .not("confirmed_at", "is", null)
    .is("deleted_at", null);
  const alreadyPaid = (paidRows ?? []).reduce((s, r) => s + Number(r.amount), 0);
  const open = trancheSoll - alreadyPaid;

  // Überzahlung: wenn amount > open UND overflow_tranche_id gesetzt,
  // splitten wir in zwei Gutschriften: open auf aktuelle Tranche, Rest auf overflow.
  const overflow = amount - open;
  const splitOverflow = overflow > 0.005 && overflow_tranche_id;

  const actorPersonId = person.id;

  async function insertCredit(targetTranche: string, targetAmount: number, idemKey?: string) {
    const { error } = await supabase
      .from("transactions")
      .insert({
        trip_id,
        type: "credit",
        date,
        description: note || `Anzahlung ${trancheLabel}`,
        amount: targetAmount,
        credit_from: person_id,
        credit_to: advancerId,
        tranche_id: targetTranche,
        created_by: actorPersonId,
        // recordPayment ist die Skipper-Aktion → direkt bestätigt
        confirmed_at: new Date().toISOString(),
        idempotency_key: idemKey,
      });
    if (error && !(error.code === PG_UNIQUE_VIOLATION && idemKey)) {
      throw error;
    }
  }

  // Tatsächlich gebuchte Splits — für Audit-Log + Notice-Mails behalten,
  // damit die Mails den Betrag pro Tranche korrekt nennen können (bei
  // Overflow geht part1 auf tranche_id, part2 auf overflow_tranche_id).
  const bookedCredits: Array<{ trancheId: string; amount: number }> = [];
  try {
    if (splitOverflow) {
      const part1 = round2(Math.max(0, Math.min(open, amount)));
      const part2 = round2(amount - part1);
      if (part1 > 0) {
        await insertCredit(tranche_id, part1, idempotency_key);
        bookedCredits.push({ trancheId: tranche_id, amount: part1 });
      }
      if (part2 > 0) {
        // Fund S-5: part2 braucht einen EIGENEN idempotency_key. Ohne ihn
        // schluckt ein Retry zwar part1 (Unique-Violation), fügt part2 aber
        // erneut ein → doppelter Overflow-Betrag auf der zweiten Tranche.
        // Aus dem Basis-Key abgeleitet, damit derselbe Retry auch part2 dedupt.
        const part2Key = idempotency_key ? `${idempotency_key}:overflow` : undefined;
        await insertCredit(overflow_tranche_id!, part2, part2Key);
        bookedCredits.push({ trancheId: overflow_tranche_id!, amount: part2 });
      }
    } else {
      await insertCredit(tranche_id, amount, idempotency_key);
      bookedCredits.push({ trancheId: tranche_id, amount });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "error", message: dbErr({ message: msg }, "Zahlung konnte nicht erfasst werden.") };
  }

  await logAudit(supabase, {
    table_name: "transactions",
    operation: "INSERT",
    record_id: tranche_id,
    trip_id,
    actor_person_id: person.id,
    payload: { kind: "prepayment", tranche_id, person_id, amount, overflow_tranche_id, note },
  });

  // Info-Mails (Crewperson + Vorstrecker, falls Actor ≠ beide). Selbst-
  // verrechnung des Vorstreckers (person_id == advancerId == actorPersonId)
  // schickt keine Mail — das ist bilanzneutral. Bei Overflow eine Mail
  // PRO gebuchter Tranche mit dem korrekten Teilbetrag, sonst stimmten
  // Betrag und Tranche in der Mail nicht überein.
  if (person_id !== actorPersonId || advancerId !== actorPersonId) {
    for (const credit of bookedCredits) {
      try {
        await sendPrepaymentNoticeMails(supabase, {
          tripId: trip_id,
          trancheId: credit.trancheId,
          kind: "payment_recorded",
          actorPersonId,
          subjectPersonId: person_id,
          amount: credit.amount,
        });
      } catch (e) {
        console.error("[bordkasse:notice-mail]", e);
      }
    }
  }

  // Push an die Crewperson (additiv zur Mail) — Actor ausgenommen. Gesamtbetrag
  // der erfassten Zahlung, nicht pro Overflow-Split.
  await sendPushToPersons(
    supabase,
    pushRecipients([person_id], { excludeActorId: actorPersonId }),
    paymentConfirmedPush({ amount, tripId: trip_id }),
  );

  revalidatePath(`/trips/${trip_id}/prepayments`);
  revalidatePath(`/trips/${trip_id}/balance`);
  revalidatePath(`/trips/${trip_id}/transactions`);
  return { status: "ok" };
}

// ────────────────────────────────────────────────────────────────────────
// 4. Crewwechsel: A → B
// ────────────────────────────────────────────────────────────────────────

export async function replaceMember(
  _prev: PrepaymentState,
  formData: FormData,
): Promise<PrepaymentState> {
  const person = await getCurrentPerson();
  if (!person) return { status: "error", message: "Nicht angemeldet." };

  const parsed = ReplaceMemberSchema.safeParse({
    trip_id: formData.get("trip_id"),
    old_person_id: formData.get("old_person_id"),
    new_display_name: formData.get("new_display_name"),
    new_email: formData.get("new_email") || "",
    new_person_id: formData.get("new_person_id") || undefined,
    handover_date: formData.get("handover_date") || "",
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe." };
  }
  const { trip_id, old_person_id, new_display_name, new_email } = parsed.data;
  // Grill-Fund P6: der Modus wird vom Radio bestimmt, NICHT allein von der
  // Anwesenheit des Datumsfelds. Ohne JavaScript (oder vor der Hydration)
  // rendert das Formular das Datumsfeld anhand des SSR-Defaults; klickt der
  // Nutzer dann nativ auf „hat abgesagt", schickt der Browser das Datum
  // trotzdem mit — der Server hätte gegen die ausdrückliche Wahl des Nutzers
  // einen Wechsel-mit-Datum ausgeführt. Explizites „cancelled" gewinnt.
  //
  // Re-Grill P4: symmetrisch muss auch „handover ohne Datum" abgelehnt
  // werden, statt in den Lösch-Pfad zu fallen. Sonst löscht ein Submit mit
  // `repl_mode=handover`, aber leerem Datumsfeld (fehlendes `required` ohne
  // JS, altes Bundle, Retry) A aus der Crew — das exakte Gegenteil der
  // ausdrücklichen Wahl, und bei einem Törn ohne Buchungen greift auch der
  // tripUnderway-Guard nicht.
  const explicitMode = formData.get("repl_mode");
  const handover_date = explicitMode === "cancelled" ? "" : parsed.data.handover_date;
  if (explicitMode === "handover" && !handover_date) {
    return { status: "error", message: "Bitte den Wechseltag angeben." };
  }
  // Fund 3 (Idempotency, Grill-Review): ohne clientseitig stabile ID würde
  // ein Netzwerk-Retry (Yacht-WLAN — siehe 0005_idempotency.sql) die neue
  // Person und den Anzahlungs-Transfer duplizieren. Der Wert ist aber
  // client-kontrolliert und wird deshalb NUR als Wunsch-ID für eine
  // Neuanlage verwendet — `assertFreshPersonId` unten weist jede ID ab, die
  // schon zu einer existierenden Person gehört (Fund F1).
  const effectiveNewPersonId = parsed.data.new_person_id ?? crypto.randomUUID();
  // Name optional: fehlt er, aus der E-Mail ableiten. Das Schema-Refine
  // garantiert, dass mindestens eins von beidem gesetzt ist.
  const effectiveName = new_display_name || displayNameFromEmail(new_email);

  const auth = await requireSkipperOrAdmin(trip_id);
  if (!auth.ok) return { status: "error", message: auth.message };

  const supabase = createAdminClient();

  const archivedCheck = await assertTripNotArchived(supabase, trip_id);
  if (!archivedCheck.ok) return { status: "error", message: archivedCheck.message };

  // 1. Original-Skipper darf nicht ersetzt werden (Audit-Spur)
  const { data: tripRow } = await supabase
    .from("trips")
    .select("skipper_id, start_date, end_date")
    .eq("id", trip_id)
    .maybeSingle();
  if (!tripRow) return { status: "error", message: "Törn nicht gefunden." };
  if (tripRow.skipper_id === old_person_id) {
    return { status: "error", message: "Der ursprüngliche Skipper kann nicht ersetzt werden." };
  }

  // 1a. Variante b (Wechsel mitten im Törn) vs. klassischer Wechsel.
  //
  //     Der klassische Pfad löscht A aus `trip_members`. Weil
  //     `v_transaction_shares` (0031) die Crew AUSSCHLIESSLICH aus
  //     `trip_members` ableitet und für equal/on_board/time_proportional
  //     keine Anteile speichert, werden dabei RÜCKWIRKEND auch alle
  //     Ausgaben VOR dem Wechsel neu verteilt: A geht mit 0 € raus, B zahlt
  //     A's Einkäufe mit. Vor Törnbeginn ist das genau richtig (es gibt
  //     nichts umzuverteilen) — sobald der Törn läuft oder Buchungen
  //     existieren, ist es ein echter Geldfehler.
  //
  //     Deshalb: läuft der Törn schon, ist ein Wechseldatum PFLICHT. Dann
  //     bleibt A mit verkürzter Anwesenheit in der Crew und zahlt weiter
  //     für die eigenen Tage; B kommt ab dem Wechseltag dazu.
  //
  //     Gezählt werden NUR Bordkasse-Buchungen (`tranche_id IS NULL`) MIT
  //     Datum ab Törnbeginn. Zwei bewusste Ausnahmen, die sonst den
  //     häufigsten Fall überhaupt blockieren würden — jemand sagt VOR dem
  //     Törn ab:
  //       • Anzahlungsbuchungen entstehen planmäßig Monate vorher und werden
  //         unten ohnehin explizit auf B übertragen.
  //       • Bordkasse-Buchungen dürfen laut Spec ein Datum VOR dem Törn
  //         tragen (Versicherung, Vorab-Einkauf). Ohne den Datumsfilter
  //         machte eine einzige Versicherungsbuchung sechs Wochen vor
  //         Abfahrt den klassischen Pfad unerreichbar — der Skipper müsste
  //         die Absage als „Wechsel mitten im Törn" erfassen und hätte A
  //         danach dauerhaft mit einem Ein-Tages-Fenster in der Crew stehen
  //         (Grill-Fund P3).
  const todayIso = new Date().toISOString().slice(0, 10);
  const { count: txCount, error: txCountErr } = await supabase
    .from("transactions")
    .select("id", { count: "exact", head: true })
    .eq("trip_id", trip_id)
    .is("tranche_id", null)
    .is("deleted_at", null)
    .gte("date", tripRow.start_date);
  if (txCountErr) {
    return { status: "error", message: dbErr(txCountErr, "Buchungen konnten nicht geprüft werden.") };
  }
  const tripUnderway = todayIso >= tripRow.start_date || (txCount ?? 0) > 0;
  const handoverMode = !!handover_date;

  if (tripUnderway && !handoverMode) {
    return {
      status: "error",
      message:
        "Dieser Törn läuft bereits oder hat schon Buchungen. Bitte gib ein Wechseldatum an — " +
        "sonst würden alle bisherigen Ausgaben rückwirkend auf die neue Person umverteilt.",
    };
  }
  if (handoverMode && (handover_date < tripRow.start_date || handover_date > tripRow.end_date)) {
    return {
      status: "error",
      message: "Das Wechseldatum muss innerhalb des Törnzeitraums liegen.",
    };
  }

  // 1b. PR 4 / Fix 2: der Vorstrecker der Anzahlung darf NICHT über diesen
  //     Wechsel ersetzt werden. Ein automatisches Mitziehen von
  //     prepayment_plan.advancer_person_id würde requireSkipperAdminOrAdvancer
  //     (lib/auth/authz.ts) unbemerkt umbiegen — das gehört bewusst in den
  //     Anzahlungs-Wizard (explizite Entscheidung des Skippers), nicht in
  //     einen Crew-Wechsel-Nebenpfad. BEWUSST vor jeder Schreib-Operation,
  //     wie der Pre-Check darunter.
  const { data: planForAdvancerCheck } = await supabase
    .from("prepayment_plan")
    .select("advancer_person_id")
    .eq("trip_id", trip_id)
    .maybeSingle();
  if (planForAdvancerCheck?.advancer_person_id === old_person_id) {
    return {
      status: "error",
      message:
        "Der Vorstrecker kann nicht über diesen Wechsel ersetzt werden — das gehört in den Anzahlungs-Wizard.",
    };
  }

  // 2. Pre-Check: eine noch unbestätigte Selbstmeldung von A blockt den
  //    Wechsel — sie bliebe sonst nach dem Wechsel an old_person_id
  //    hängen, während dessen Anzahlungssoll schon auf B umgezogen ist
  //    (Bestätigung landet dann auf einer Person ohne Soll, Ablehnung
  //    bräuchte eine Vorstrecker-Mail an eine Person, die gerade "abreist").
  //    Der Skipper soll erst bewusst bestätigen oder ablehnen (Matrix),
  //    statt dass wir die Meldung stillschweigend verwerfen oder übernehmen.
  //    BEWUSST vor jeder Schreib-Operation (Grill-Review-Fund): dieser Check
  //    hing früher NACH der Personen-/Crew-Anlage — ein Reject hätte trotzdem
  //    schon eine Ghost-Person + Creweintrag hinterlassen (Orphan), obwohl
  //    der gesamte Wechsel abgelehnt wurde.
  const { count: pendingCount } = await supabase
    .from("transactions")
    .select("id", { count: "exact", head: true })
    .eq("trip_id", trip_id)
    .eq("credit_from", old_person_id)
    .eq("type", "credit")
    .not("tranche_id", "is", null)
    .is("confirmed_at", null)
    .is("deleted_at", null);
  if ((pendingCount ?? 0) > 0) {
    return {
      status: "error",
      message:
        "Diese Person hat noch eine unbestätigte Anzahlungs-Selbstmeldung. Bitte erst in der " +
        "Anzahlungs-Matrix bestätigen oder ablehnen, bevor du sie ersetzt.",
    };
  }

  // 2b. PR 4 / Fix 3: Vorab-Buchungsspur-Check, BEVOR irgendetwas geschrieben
  //     wird. Fix 1 (unten, Schritt 6) hängt gleich ALLE nicht-Selbst-
  //     Verrechnungs-Gutschriften von A auf B um (UPDATE credit_from) — nach
  //     diesem Umhängen dürfte an A keine Buchungsspur mehr hängen, sonst
  //     bliebe die trip_members-Zeile ein Fremdkörper (v_balances ist rein
  //     mitgliedschaftsgetrieben, siehe 0043) und dürfte NICHT gelöscht
  //     werden (Fund 6-Analogon aus removeMember).
  //
  //     Es gibt keine echte DB-Transaktion über den Service-Role-Client
  //     (Client macht keine BEGIN/COMMIT-Klammer um mehrere Requests) — statt
  //     hinterher zu prüfen und bei Fehlschlag kompensierend zurückzurollen,
  //     wird HIER GEDANKLICH vorweggenommen, was nach dem Umhängen übrig
  //     bliebe: `includeCreditFrom: false`, weil genau die credit_from-Zeilen
  //     gleich umgehängt werden und deshalb NICHT als blockierende Spur
  //     zählen dürfen. paid_by- und credit_to-Zeilen (jemand hat A eine
  //     Gutschrift gegeben, oder A hat eine Ausgabe bezahlt) werden von
  //     Fix 1 NICHT angefasst und bleiben daher blockierend — die einzige
  //     Ausnahme sind Selbstverrechnungen (credit_from = credit_to = A),
  //     die über `credit_to.eq.A` in personHasBookingTrace ohnehin erfasst
  //     bleiben (bewusst: A ist per Fix 2 nie Vorstrecker, Selbstverrechnung
  //     an A wäre also ohnehin ein Datenanomalie-Fall, den wir lieber blocken
  //     als stillschweigend verlieren).
  //
  //     Variante b: im Wechseldatum-Modus bleibt A in der Crew, es wird also
  //     gar nichts gelöscht — eine Buchungsspur ist dort völlig unschädlich
  //     (A zahlt weiter für die eigenen Tage) und darf den Wechsel nicht
  //     blockieren. Genau das ist der Fall, für den Variante b gebaut wurde:
  //     mitten im Törn hat die abreisende Person praktisch immer Buchungen.
  if (
    !handoverMode &&
    (await personHasBookingTrace(supabase, trip_id, old_person_id, { includeCreditFrom: false }))
  ) {
    return {
      status: "error",
      message:
        "Diese Person hat noch Buchungen in diesem Törn, die nicht automatisch übertragen werden " +
        "können (z. B. als Zahler einer Ausgabe, als Empfänger einer Gutschrift oder als Beteiligte " +
        "einer Pro-Person-/Individuell-Aufteilung). Bitte erst die Buchungen umbuchen, bevor du sie ersetzt.",
    };
  }

  // 2c. Fund F1 (Security): `new_person_id` kommt roh aus einem Hidden-Input
  //     und wurde bisher ungeprüft als Upsert-Schlüssel auf `persons` /
  //     `persons_private` / `trip_members` benutzt — über den Service-Role-
  //     Client, also ohne RLS. Weil `persons` für jeden Eingeloggten lesbar
  //     ist (0004_rls.sql, USING TRUE), sind alle Personen-UUIDs bekannt:
  //     ein Skipper von Törn X konnte damit `display_name` und
  //     `persons_private.email` einer Ghost-Person aus Törn Y überschreiben,
  //     sich anschließend mit dieser Adresse einloggen (die Whitelist prüft
  //     nur, ob die E-Mail in `persons_private` steht) und wurde per
  //     Ghost-Verlinkung (get-current-person.ts) zu dieser Person — inklusive
  //     Zugriff auf den fremden Törn. Nebenvarianten: eine ID aus DIESEM Törn
  //     überschreibt Anwesenheit + Anzahlungssoll des Opfers, und
  //     `new_person_id = old_person_id` ließ das finale DELETE genau die eben
  //     angelegte Zeile treffen (verwaiste Obligation, Σ Soll ≠ Plan).
  //
  //     Fix analog zum Kojen-Check in savePrepaymentPlan: die ID darf nur
  //     eine NEUANLAGE adressieren, nie eine bestehende Zeile.
  //
  //     ⚠️ Das kostet die Retry-Idempotenz (Grill-Fund P4): hat Attempt 1 die
  //     Person schon angelegt und scheiterte erst danach, meldet Attempt 2
  //     mit derselben ID „bereits vergeben", und ein Reload würfelt eine
  //     neue ID — der Skipper muss in der Crewliste nachsehen, was von
  //     Attempt 1 übrig ist. Bewusst so gewählt: eine bestehende Zeile per
  //     Client-ID adressierbar zu lassen WAR die Lücke. Ein „reuse, wenn es
  //     ein spurloser Ghost ist" würde sie wieder öffnen, weil ein fremdes
  //     Crewmitglied desselben Törns von einer frisch angelegten Waise nicht
  //     unterscheidbar ist.
  const ID_TAKEN_MSG =
    "Die neue Person konnte nicht angelegt werden (ID bereits vergeben). " +
    "Bitte lade die Seite neu und versuche es erneut.";
  // Zwei parallele Submits passieren beide den Vorab-Check; der Verlierer
  // prallt am Primärschlüssel ab. Dieselbe freundliche Meldung wie beim
  // Vorab-Check, statt einer nackten DB-Fehlermeldung.
  const personInsertError = (err: { code?: string; message: string } | null): string =>
    err?.code === PG_UNIQUE_VIOLATION ? ID_TAKEN_MSG : dbErr(err, "Person konnte nicht angelegt werden.");

  const assertFreshPersonId = async (): Promise<string | null> => {
    const { data: clash, error } = await supabase
      .from("persons")
      .select("id")
      .eq("id", effectiveNewPersonId)
      .maybeSingle();
    if (error) return dbErr(error, "Personen-Prüfung fehlgeschlagen.");
    if (clash) return ID_TAKEN_MSG;
    return null;
  };

  // 2d. Fund F4: A's Creweintrag laden, BEVOR irgendetwas geschrieben wird.
  //     Dieser Lookup hing früher hinter der Personen-Anlage — schlug er fehl
  //     ("Alte Crewperson nicht gefunden", z. B. weil A parallel entfernt
  //     wurde oder der Tab veraltet war), blieb eine Personen-Zeile ohne jede
  //     Mitgliedschaft zurück, deren E-Mail die UNIQUE-Constraint auf
  //     persons_private.email belegte und die zudem die Login-Whitelist
  //     passiert hätte.
  const { data: oldMember, error: oldMemberErr } = await supabase
    .from("trip_members")
    .select("id, on_board_from, on_board_to, is_alcoholic, note, is_skipper")
    .eq("trip_id", trip_id)
    .eq("person_id", old_person_id)
    .maybeSingle();
  if (oldMemberErr) {
    return { status: "error", message: dbErr(oldMemberErr, "Creweintrag konnte nicht geladen werden.") };
  }
  if (!oldMember) return { status: "error", message: "Alte Crewperson nicht gefunden." };

  // Variante b: das Wechseldatum muss im Anwesenheitsfenster von A liegen —
  // sonst entstünde entweder ein negatives Fenster für A (Wechsel vor A's
  // Ankunft) oder ein B, das erst nach A's Abreise anfängt und die Lücke
  // dazwischen unbesetzt lässt.
  const oldFrom = oldMember.on_board_from ?? tripRow.start_date;
  const oldTo = oldMember.on_board_to ?? tripRow.end_date;
  if (handoverMode && (handover_date < oldFrom || handover_date > oldTo)) {
    return {
      status: "error",
      message:
        `Das Wechseldatum muss im Anwesenheitszeitraum der bisherigen Person liegen ` +
        `(${oldFrom} bis ${oldTo}).`,
    };
  }

  // 3. Neue Person anlegen (oder bestehende per E-Mail nachladen)
  //
  // Fund 9 (Code-Review 2026-08): `.eq` statt `.ilike` (CITEXT ist bereits
  // case-insensitiv) + Fehler geprüft, statt ihn still als "nicht gefunden"
  // durchzureichen.
  //
  // Bekannte, akzeptierte Lücke (Grill-Review-Fund): landet new_email auf
  // eine bereits EXISTIERENDE Person, die schon Crew dieses Törns ist (der
  // Guard direkt unten), schlägt ein echter Retry NACH einem bereits
  // erfolgreichen ersten Versuch mit genau dieser Fehlermeldung fehl statt
  // idempotent No-Op zu sein — SICHER (kein Doppel-Merge), aber nicht
  // idempotent. Ein Fix müsste "das ist meine eigene vorige Anfrage" von
  // "das ist eine andere, echte Kollision" unterscheiden, ohne sich auf
  // new_person_id zu verlassen (der Wert ist client-kontrolliert und daher
  // KEIN vertrauenswürdiger Beweis für "das war ich selbst" — sonst ließe
  // sich der Collision-Guard von Fund 1 per manipuliertem Hidden-Feld
  // aushebeln). Ghost-ohne-E-Mail und "komplett neue Person per E-Mail"
  // bleiben voll idempotent.
  //
  // Weitere bekannte, akzeptierte Lücke (Grill-Review-Fund, PR 4): es gibt
  // KEINE echte DB-Transaktion über den Service-Role-Client um die
  // restlichen Schritte dieser Funktion (Person/Crew-Anlage → Obligation-
  // Transfer → Credit-Reassign → Audience-Upsert → trip_members-DELETE).
  // Schlägt einer dieser Schritte NACH der Personen-/Crew-Anlage fehl (z.B.
  // ein DB-Fehler beim Credit-Reassign), bleibt B als angelegte Crew mit
  // bereits übertragenem Anzahlungssoll stehen, während A's trip_members-
  // Zeile noch existiert (DELETE kommt erst ganz am Ende) — ein manuell zu
  // bereinigender Zwischenzustand. Ein Retry mit derselben new_person_id
  // repariert das größtenteils (die Schritte sind einzeln idempotent), aber
  // ohne automatischen Rollback. Proportional zum Rest der Codebase
  // akzeptiert (kompensierende Rollbacks existieren nur an einzelnen,
  // besonders kritischen Stellen, z.B. updateExpense/S-4) — eine echte
  // Transaktionsklammer wäre ein eigener, größerer Umbau.
  let newPersonId: string;
  if (new_email) {
    const { data: existingPriv, error: lookupErr } = await supabase
      .from("persons_private")
      .select("person_id")
      .eq("email", new_email)
      .maybeSingle();
    if (lookupErr) return { status: "error", message: dbErr(lookupErr, "E-Mail-Suche fehlgeschlagen.") };
    if (existingPriv) {
      // Pre-Check: ist diese Person schon Crew DIESES Törns? Sonst würde
      // replaceMember ihre trip_members-/prepayment_obligations-Zeile
      // stillschweigend überschreiben (Anwesenheit/Koje/Soll von old_person_id
      // draufgebügelt) und eine Gutschrift zwischen zwei voneinander
      // unabhängigen Personen erzeugen — ohne Fehler, ohne Rückfrage.
      const { data: alreadyMember } = await supabase
        .from("trip_members")
        .select("id")
        .eq("trip_id", trip_id)
        .eq("person_id", existingPriv.person_id)
        .maybeSingle();
      if (alreadyMember) {
        return {
          status: "error",
          message:
            "Diese E-Mail-Adresse gehört bereits zu einem Crewmitglied dieses Törns. " +
            "Wähle eine andere E-Mail-Adresse oder lege die neue Person ohne E-Mail als Ghost an.",
        };
      }
      newPersonId = existingPriv.person_id;
    } else {
      // insert-by-id statt upsert (Fund F1): die ID ist client-kontrolliert
      // und darf nur eine Neuanlage adressieren. `assertFreshPersonId`
      // schließt eine bestehende Zeile vorab aus, `insert` ist danach der
      // sichere Schreibbefehl — ein paralleler Zweitversuch prallt an der
      // Primärschlüssel-Constraint ab, statt fremde Daten zu überschreiben.
      const idClash = await assertFreshPersonId();
      if (idClash) return { status: "error", message: idClash };
      const { data: created, error } = await supabase
        .from("persons")
        .insert({ id: effectiveNewPersonId, display_name: effectiveName })
        .select("id")
        .single();
      if (error || !created) return { status: "error", message: personInsertError(error) };
      newPersonId = created.id;
      const { error: privErr } = await supabase
        .from("persons_private")
        .insert({ person_id: newPersonId, email: new_email });
      if (privErr) {
        // Kompensierende Aktion (Grill-Fund P4): ohne sie bliebe eine
        // Personen-Zeile ohne E-Mail und ohne Mitgliedschaft zurück, die ein
        // Retry mit derselben ID nie wieder erreichen könnte (der F1-Guard
        // weist die ID ab) — der Wechsel wäre dauerhaft blockiert.
        await supabase.from("persons").delete().eq("id", newPersonId);
        return { status: "error", message: dbErr(privErr, "E-Mail konnte nicht gespeichert werden.") };
      }
    }
  } else {
    // Ghost-Person ohne E-Mail — ebenfalls insert-by-id (Fund F1).
    const idClash = await assertFreshPersonId();
    if (idClash) return { status: "error", message: idClash };
    const { data: created, error } = await supabase
      .from("persons")
      .insert({ id: effectiveNewPersonId, display_name: effectiveName })
      .select("id")
      .single();
    if (error || !created) return { status: "error", message: personInsertError(error) };
    newPersonId = created.id;
  }

  // 4. Neue Person als Crew anlegen.
  //
  //    Klassisch (vor Törnbeginn): B übernimmt A's Anwesenheitsfenster 1:1.
  //    Variante b: B startet am Wechseltag und bleibt bis zu A's
  //    ursprünglichem Ende; A wird weiter unten auf den Wechseltag verkürzt.
  //    Der Wechseltag selbst gehört bewusst BEIDEN — an einem Übergabetag
  //    sind Abreisende und Nachrücker typischerweise zusammen an Bord.
  //
  //    `is_skipper` (Fund F5): im klassischen Pfad verschwindet A komplett,
  //    also müssen ihre Co-Skipper-Rechte auf B übergehen — sonst steht eine
  //    Crew ohne handlungsfähigen Ansprechpartner an Bord, sobald der
  //    Original-Skipper nicht mitsegelt. In Variante b bleibt A in der Crew
  //    und behält die Rechte; B bekommt sie NICHT automatisch.
  const { data: newMember, error: tmErr } = await supabase
    .from("trip_members")
    .upsert(
      {
        trip_id,
        person_id: newPersonId,
        on_board_from: handoverMode ? handover_date : oldMember.on_board_from,
        // Re-Grill P5: NICHT `oldTo` (das materialisierte Törnende), sondern
        // A's Originalwert — war er NULL („bis Törnende"), soll auch B NULL
        // bekommen, sonst folgt B als einziges Mitglied einer späteren
        // Törnverlängerung (updateTripDates) nicht mehr. Gleiche Begründung
        // wie beim Verkürzen von A's `on_board_from` weiter unten.
        on_board_to: oldMember.on_board_to,
        is_alcoholic: oldMember.is_alcoholic,
        note: oldMember.note,
        is_skipper: handoverMode ? false : oldMember.is_skipper,
      },
      { onConflict: "trip_id,person_id" },
    )
    .select("id")
    .single();
  if (tmErr || !newMember) return { status: "error", message: dbErr(tmErr, "Creweintrag konnte nicht angelegt werden.") };

  // 5. Obligation von A auf B übertragen (Cabin bleibt)
  const { data: oldObl } = await supabase
    .from("prepayment_obligations")
    .select("cabin_type_id, total_amount")
    .eq("trip_id", trip_id)
    .eq("person_id", old_person_id)
    .maybeSingle();
  if (oldObl) {
    const { error: oblDeleteErr } = await supabase
      .from("prepayment_obligations")
      .delete()
      .eq("trip_id", trip_id)
      .eq("person_id", old_person_id);
    if (oblDeleteErr) return { status: "error", message: dbErr(oblDeleteErr, "Anzahlungssoll konnte nicht übertragen werden.") };
    const { error: oblUpsertErr } = await supabase.from("prepayment_obligations").upsert(
      {
        trip_id,
        person_id: newPersonId,
        cabin_type_id: oldObl.cabin_type_id,
        total_amount: oldObl.total_amount,
      },
      { onConflict: "trip_id,person_id" },
    );
    if (oblUpsertErr) return { status: "error", message: dbErr(oblUpsertErr, "Anzahlungssoll konnte nicht übertragen werden.") };
  }

  // 6. PR 4 / Fix 1: ALLE Gutschriften, die A gegeben hat (credit_from =
  //    old_person_id — Pool- UND Bordkasse-Gutschriften, nicht nur
  //    Tranchen), werden direkt auf B umgehängt (UPDATE, keine neue Zeile).
  //
  //    Vorherige Implementierung erzeugte stattdessen pro bestätigter
  //    Anzahlungs-Zahlung eine synthetische Gegen-Gutschrift "B → A" — das
  //    ließ A's ursprüngliche Zahlung an alter Stelle stehen (credit_from
  //    weiterhin A), obwohl A gerade aus trip_members entfernt wird. Weil
  //    v_balances rein mitgliedschaftsgetrieben ist (FROM crew, siehe
  //    0043_review_fixes_q4_q5_q6.sql), verschwindet eine solche Zeile mit
  //    credit_from auf eine NICHT mehr in trip_members stehende Person
  //    spurlos aus der Bilanz-Summe — Geld "verdunstet" (Σ balance ≠ 0),
  //    und `all_debts_settled` wird nie wahr (Purge-Blocker).
  //
  //    AUSSER Selbstverrechnungen (credit_from = credit_to = old_person_id,
  //    seit 0024 für den Vorstrecker erlaubt): ein blindes Umhängen würde
  //    daraus eine ECHTE Geldbewegung "B → A" machen. Da A laut Fix 2 nie
  //    Vorstrecker ist, sollte dieser Fall praktisch nie auftreten — trotzdem
  //    defensiv ausgeschlossen, und über den Fix-3-Pre-Check oben (der
  //    credit_to = old_person_id als blockierende Spur zählt) hätte eine
  //    verbleibende Selbstverrechnung den Wechsel ohnehin schon verhindert.
  //
  //    Idempotent von Natur aus (kein `idempotency_key`/Unique-Violation-
  //    Handling nötig wie bei der alten Insert-Variante): ein Retry findet
  //    beim zweiten Versuch keine Zeilen mehr mit credit_from = old_person_id
  //    (sie tragen ja schon newPersonId) — die UPDATE-Query matcht dann 0
  //    Zeilen, kein Doppel-Effekt.
  //
  //    ⚠️ Variante b: dort werden NUR die tranche-getaggten Gutschriften
  //    (= Anzahlungszahlungen) übertragen. A bleibt in der Crew, also ist
  //    eine gewöhnliche Bordkasse-Gutschrift von A weiterhin A's eigene
  //    Geldbewegung — sie umzuhängen würde A's Guthaben stehlen und B eine
  //    Zahlung gutschreiben, die B nie geleistet hat. Im klassischen Pfad
  //    verschwindet A dagegen komplett, dort MÜSSEN alle Gutschriften mit,
  //    sonst verdunstet Geld aus der Bilanzsumme (siehe oben).
  const creditQuery = supabase
    .from("transactions")
    .select("id, amount, credit_to")
    .eq("trip_id", trip_id)
    .eq("credit_from", old_person_id)
    .eq("type", "credit")
    .is("deleted_at", null);
  if (handoverMode) creditQuery.not("tranche_id", "is", null);
  const { data: creditsToReassign, error: creditsSelectErr } = await creditQuery;
  if (creditsSelectErr) {
    return { status: "error", message: dbErr(creditsSelectErr, "Gutschriften konnten nicht geladen werden.") };
  }
  const reassignable = (creditsToReassign ?? []).filter((c) => c.credit_to !== old_person_id);
  const transferredSum = reassignable.reduce((sum, c) => sum + Number(c.amount), 0);
  if (reassignable.length > 0) {
    const { error: reassignErr } = await supabase
      .from("transactions")
      .update({ credit_from: newPersonId })
      .in(
        "id",
        reassignable.map((c) => c.id),
      );
    if (reassignErr) return { status: "error", message: dbErr(reassignErr, "Gutschriften konnten nicht übertragen werden.") };
  }

  // 7. PR 4 / Fix 4: bevor A aus trip_members verschwindet, die Cross-Trip-
  //    Statistik-Sichtbarkeit sichern (analog purge_trip_data, siehe
  //    0020_trip_statistics_audience.sql) — sonst verliert A (falls A schon
  //    mal eingeloggt war) diesen Törn dauerhaft aus /stats, weil die
  //    dortigen RLS-Policies ohne Mitgliedschaft und ohne Audience-Zeile
  //    keinen Lesezugriff mehr gewähren.
  //    In Variante b bleibt A Crew — die Audience-Zeile ist dort unnötig.
  const { data: oldPersonRow } = await supabase
    .from("persons")
    .select("auth_user_id")
    .eq("id", old_person_id)
    .maybeSingle();
  if (!handoverMode && oldPersonRow?.auth_user_id) {
    const { error: audienceErr } = await supabase
      .from("trip_statistics_audience")
      .upsert({ person_id: old_person_id, trip_id }, { onConflict: "person_id,trip_id" });
    if (audienceErr) {
      return { status: "error", message: dbErr(audienceErr, "Statistik-Zugriff konnte nicht gesichert werden.") };
    }
  }

  // 7b. Grill-Review-Fund (PR 4): der Pre-Check in Schritt 2b lief GANZ am
  //     Anfang, bevor irgendetwas geschrieben wurde — zwischen ihm und dem
  //     DELETE unten liegen mehrere DB-Roundtrips (Personen-/Crew-Anlage,
  //     Obligation-Transfer, Credit-Reassign, Audience-Upsert) ohne Lock
  //     oder echte Transaktion. Legt in diesem Fenster jemand parallel eine
  //     neue Buchung mit paid_by/credit_to = A an, würde das DELETE unten
  //     sonst unbemerkt durchlaufen und genau den Bilanz-Fehler wieder
  //     einführen, den Fix 1/3 beheben sollen. Deshalb unmittelbar VOR dem
  //     DELETE erneut prüfen — engt das Race-Fenster auf die Zeit zwischen
  //     dieser Prüfung und dem DELETE-Statement selbst ein (kein triviales
  //     Nullen, aber eine echte DB-Transaktion über den Service-Role-Client
  //     ist hier nicht verfügbar, siehe andere Stellen in dieser Datei).
  //
  //     In Variante b entfällt der Re-Check: dort wird nichts gelöscht, eine
  //     parallel entstandene Buchung von A bleibt einfach bei A.
  if (
    !handoverMode &&
    (await personHasBookingTrace(supabase, trip_id, old_person_id, { includeCreditFrom: false }))
  ) {
    return {
      status: "error",
      message:
        "Diese Person hat inzwischen eine neue Buchung in diesem Törn bekommen. " +
        "Bitte Seite neu laden und erneut versuchen.",
    };
  }

  // 8. A aus der Crew nehmen — auf zwei Arten, je nach Modus.
  //
  //    Variante b (Wechseldatum): A bleibt Crew, nur das Anwesenheitsfenster
  //    endet am Wechseltag. Damit zahlt A weiterhin für die eigenen Tage.
  //    ⚠️ Das repariert `on_board` (und individual/per_person) vollständig,
  //    NICHT aber `equal`: dort ist das aktive Set laut v_transaction_shares
  //    (0031) ALLE trip_members, völlig datumsblind — das zusätzliche
  //    Mitglied senkt rückwirkend den Anteil aller an jeder bisherigen
  //    „Gleichmäßig"-Ausgabe (Grill-Fund P1, numerisch nachgestellt: 400 €
  //    an Tag 2 bei 4 Personen → je 100 €; nach dem Wechsel 5 Zeilen → je
  //    80 €, und der Nachrücker zahlt 80 € für einen Einkauf von vor seiner
  //    Ankunft). Bei `time_proportional` bleibt ein kleiner Effekt (der
  //    Übergabetag zählt für beide, Σ Tage steigt um eins). Das Formular
  //    warnt deshalb mit der Zahl der betroffenen Buchungen; automatisch
  //    umschreiben würde fremde Buchungen irreversibel verändern.
  //
  //    Klassisch (vor Törnbeginn): A WIRKLICH aus trip_members entfernen
  //    (DELETE, nicht on_board_from/to auf NULL setzen — NULL bedeutet im
  //    Schema "ab Törn-Start" / "bis Törnende", also VOLLE Anwesenheit, exakt
  //    das Gegenteil der Absicht). Die Pre-Checks oben plus das Umhängen der
  //    Gutschriften stellen sicher, dass an A keine Buchungsspur mehr hängt.
  if (handoverMode) {
    const { error: shortenErr } = await supabase
      .from("trip_members")
      // Grill-Fund P7: `on_board_from` bewusst NICHT mitschreiben. War es
      // NULL („ab Törnbeginn"), soll es NULL bleiben — sonst folgt A als
      // einziges Crewmitglied einer späteren Törnstart-Verschiebung
      // (updateTripDates) nicht mehr.
      .update({ on_board_to: handover_date })
      .eq("id", oldMember.id);
    if (shortenErr) {
      return { status: "error", message: dbErr(shortenErr, "Anwesenheit der bisherigen Person konnte nicht angepasst werden.") };
    }
  } else {
    const { error: deleteErr } = await supabase.from("trip_members").delete().eq("id", oldMember.id);
    if (deleteErr) return { status: "error", message: dbErr(deleteErr, "Alte Crewmitgliedschaft konnte nicht entfernt werden.") };

    // Fund F3: `settled_debts` referenziert die Person direkt (kein FK auf
    // trip_members) — ohne Aufräumen bliebe ein Häkchen für eine Person
    // stehen, die es im Törn nicht mehr gibt. `removeMember` tut das schon
    // lange (trip-members.ts), `replaceMember` hat es nie getan.
    const { error: sdErr } = await supabase
      .from("settled_debts")
      .delete()
      .eq("trip_id", trip_id)
      .or(`from_person_id.eq.${old_person_id},to_person_id.eq.${old_person_id}`);
    if (sdErr) console.error("[bordkasse:db] settled_debts cleanup:", sdErr.message);

    // Fund F7: dieselbe Klasse — tote Dedup-Zeilen des Anzahlungs-Reminders.
    // Folgenlos für B (eigene person_id), würde aber eine fällige Mahnung
    // unterdrücken, falls A dem Törn später erneut beitritt.
    const { data: trancheIds } = await supabase
      .from("prepayment_tranches")
      .select("id")
      .eq("trip_id", trip_id);
    const ids = (trancheIds ?? []).map((t) => t.id);
    if (ids.length > 0) {
      const { error: logErr } = await supabase
        .from("prepayment_reminder_log")
        .delete()
        .eq("person_id", old_person_id)
        .in("tranche_id", ids);
      if (logErr) console.error("[bordkasse:db] reminder_log cleanup:", logErr.message);
    }
  }

  await logAudit(supabase, {
    table_name: "trip_members",
    operation: handoverMode ? "UPDATE" : "DELETE",
    record_id: oldMember.id,
    trip_id,
    actor_person_id: person.id,
    payload: {
      kind: "crew-replacement",
      mode: handoverMode ? "handover" : "remove",
      handover_date: handoverMode ? handover_date : null,
      old_person_id,
      new_person_id: newPersonId,
      transferred_sum: transferredSum,
    },
  });

  // Optional: Magic-Link für die neue Person — aber NUR wenn sie noch nie
  // eingeloggt war (auth_user_id NULL). Sonst hätte jeder Wechsel auf eine
  // per E-Mail bereits bestehende, längst aktive Person eine (Re-)Invite-
  // Mail ausgelöst (Konvention wie bei inviteMember/updateMember: nur
  // Neuanlage invited). Bewusst NICHT über ein "wasCreated"-Flag aus DIESEM
  // Aufruf entschieden (Grill-Review-Fund): bei einem Retry nach einem
  // Absturz VOR dem Mail-Versand (aber NACH der Personen-Anlage) würde der
  // zweite Versuch die Person per E-Mail wiederfinden ("bereits existierend"-
  // Zweig) und die Mail damit dauerhaft verschluckt bekommen — der neue Ghost
  // stünde ohne jede Möglichkeit da, sich je einzuloggen. Der auth_user_id-
  // Check ist retry-sicher: eine bisher unbestätigte Ghost-Person bleibt
  // NULL, bis sie sich tatsächlich einmal einloggt.
  if (new_email) {
    const { data: newPersonRow } = await supabase
      .from("persons")
      .select("auth_user_id")
      .eq("id", newPersonId)
      .maybeSingle();
    if (!newPersonRow?.auth_user_id) {
      try {
        const hdrs = await headers();
        const origin = resolveOrigin(hdrs.get("origin"));
        await sendInvitationMagicLink(new_email, origin);
      } catch (e) {
        console.error("[bordkasse:invite]", e);
      }
    }
  }

  // Fund F2: ein Crewwechsel verändert die Bilanz gleich zweifach (die
  // Anteile folgen der Mitgliedschaft, und die Anzahlungszahlungen wechseln
  // den Zahler) — nach verschickter Abrechnung muss die Crew deshalb den
  // "Bilanz hat sich geändert"-Banner sehen, genau wie bei einer
  // nachträglichen Buchung (lib/actions/transactions.ts). Ohne den Marker
  // ist `resendSettlement` gesperrt und die Crew rechnet dauerhaft mit der
  // veralteten Abrechnungsmail weiter. Mail-Fehler dürfen den Wechsel nicht
  // scheitern lassen — deshalb nur geloggt.
  {
    const { error: markErr } = await supabase.rpc("mark_post_settlement_change", { p_trip_id: trip_id });
    if (markErr) console.error("[bordkasse:db] mark_post_settlement_change:", markErr.message);
  }

  revalidatePath(`/trips/${trip_id}/prepayments`);
  revalidatePath(`/trips/${trip_id}/balance`);
  revalidatePath(`/trips/${trip_id}/settings`);
  // Fund F6: die Schulden-Seite zeigt den kompletten Zahlungsplan und die
  // Buchungsliste den Gutschrift-Geber — beide ändern sich hier.
  revalidatePath(`/trips/${trip_id}/debts`);
  revalidatePath(`/trips/${trip_id}/transactions`);
  revalidatePath(`/trips/${trip_id}`);
  return { status: "ok" };
}

// ────────────────────────────────────────────────────────────────────────
// 5. Reminder-Mail an einzelne Crew
// ────────────────────────────────────────────────────────────────────────

const ReminderSchema = z.object({
  trip_id: z.string().uuid(),
  person_id: z.string().uuid(),
});

export async function sendPrepaymentReminder(
  _prev: PrepaymentState,
  formData: FormData,
): Promise<PrepaymentState> {
  const parsed = ReminderSchema.safeParse({
    trip_id: formData.get("trip_id"),
    person_id: formData.get("person_id"),
  });
  if (!parsed.success) return { status: "error", message: "Ungültige Eingabe." };

  // Vorstrecker darf auch erinnern — er ist Empfänger und hat ein
  // berechtigtes Interesse, dass seine Crew zeitnah überweist.
  const auth = await requireSkipperAdminOrAdvancer(parsed.data.trip_id);
  if (!auth.ok) return { status: "error", message: auth.message };

  const { sendPrepaymentReminderMail } = await import("@/lib/email/send-prepayment-reminder");
  const result = await sendPrepaymentReminderMail({
    tripId: parsed.data.trip_id,
    personId: parsed.data.person_id,
  });
  if (!result.ok) return { status: "error", message: result.message };

  revalidatePath(`/trips/${parsed.data.trip_id}/prepayments`);
  return { status: "ok" };
}

// ════════════════════════════════════════════════════════════════════════
// PHASE 2 — Crew-Selbstmeldung
// Crew klickt „Ich habe gezahlt" → pending-Eintrag, Skipper bestätigt/lehnt ab.
// ════════════════════════════════════════════════════════════════════════

const SubmitSelfPaymentSchema = z.object({
  trip_id: z.string().uuid(),
  tranche_id: z.string().uuid(),
  amount: z.preprocess(
    (v) => (typeof v === "string" ? v.replace(",", ".") : v),
    z.coerce.number().positive("Betrag muss > 0 sein."),
  ),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum-Format YYYY-MM-DD."),
  note: z.string().trim().max(200).optional().or(z.literal("")),
});

/**
 * Crewmitglied meldet eine geleistete Anzahlung. Erzeugt eine reguläre
 * Gutschrift mit `confirmed_at = NULL` (= pending). Der Skipper bekommt
 * eine Mail und kann in der Matrix bestätigen oder ablehnen.
 */
export async function submitSelfPayment(
  _prev: PrepaymentState,
  formData: FormData,
): Promise<PrepaymentState> {
  const person = await getCurrentPerson();
  if (!person) return { status: "error", message: "Nicht angemeldet." };

  const parsed = SubmitSelfPaymentSchema.safeParse({
    trip_id: formData.get("trip_id"),
    tranche_id: formData.get("tranche_id"),
    amount: formData.get("amount"),
    date: formData.get("date"),
    note: formData.get("note") || "",
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe." };
  }
  const { trip_id, tranche_id, amount, date, note } = parsed.data;

  const auth = await requireMember(trip_id);
  if (!auth.ok) return { status: "error", message: auth.message };

  const supabase = createAdminClient();

  const archivedCheck = await assertTripNotArchived(supabase, trip_id);
  if (!archivedCheck.ok) return { status: "error", message: archivedCheck.message };

  // Vorstrecker (Empfänger) ermitteln
  const [{ data: tripRow }, { data: planRow }, { data: trancheRow }] = await Promise.all([
    supabase.from("trips").select("skipper_id, name").eq("id", trip_id).maybeSingle(),
    supabase.from("prepayment_plan").select("advancer_person_id").eq("trip_id", trip_id).maybeSingle(),
    supabase.from("prepayment_tranches").select("label").eq("id", tranche_id).eq("trip_id", trip_id).maybeSingle(),
  ]);
  if (!tripRow || !trancheRow) return { status: "error", message: "Törn/Tranche nicht gefunden." };
  const advancerId = planRow?.advancer_person_id || tripRow.skipper_id;

  // Crewmitglied kann nur für SICH selbst melden (nicht für andere).
  // Per definitionem ist auth.personId = die meldende Person.
  const { data: tx, error } = await supabase
    .from("transactions")
    .insert({
      trip_id,
      type: "credit",
      date,
      description: note || `Anzahlung ${trancheRow.label} (selbst gemeldet)`,
      amount,
      credit_from: auth.personId,
      credit_to: advancerId,
      tranche_id,
      created_by: auth.personId,
      confirmed_at: null, // ← pending
    })
    .select("id")
    .single();
  if (error || !tx) return { status: "error", message: dbErr(error, "Meldung konnte nicht gespeichert werden.") };

  await logAudit(supabase, {
    table_name: "transactions",
    operation: "INSERT",
    record_id: tx.id,
    trip_id,
    actor_person_id: auth.personId,
    payload: { kind: "self-payment-pending", tranche_id, amount },
  });

  // Mail an Skipper (fire-and-forget)
  try {
    const { sendPaymentPendingMail } = await import("@/lib/email/send-payment-pending");
    await sendPaymentPendingMail({ tripId: trip_id, transactionId: tx.id });
  } catch (e) {
    console.error("[bordkasse:pending-mail]", e);
  }

  // Push an den Vorstrecker (additiv zur Mail) — die meldende Person selbst
  // nicht (pushRecipients filtert den Actor; greift, falls der Vorstrecker
  // ausnahmsweise für sich selbst meldet).
  await sendPushToPersons(
    supabase,
    pushRecipients([advancerId], { excludeActorId: auth.personId }),
    paymentPendingPush({
      payerName: person.display_name,
      amount,
      tripId: trip_id,
      trancheId: tranche_id,
      payerPersonId: auth.personId,
    }),
  );

  revalidatePath(`/trips/${trip_id}/prepayments`);
  return { status: "ok" };
}

const ConfirmRejectSchema = z.object({
  transaction_id: z.string().uuid(),
});

/**
 * Skipper bestätigt eine selbst gemeldete Anzahlung — `confirmed_at = now()`,
 * Buchung zählt ab sofort in `v_prepayment_payments`.
 */
export async function confirmSelfPayment(
  _prev: PrepaymentState,
  formData: FormData,
): Promise<PrepaymentState> {
  const person = await getCurrentPerson();
  if (!person) return { status: "error", message: "Nicht angemeldet." };

  const parsed = ConfirmRejectSchema.safeParse({ transaction_id: formData.get("transaction_id") });
  if (!parsed.success) return { status: "error", message: "Ungültige Buchungs-ID." };

  const supabase = createAdminClient();
  const { data: tx } = await supabase
    .from("transactions")
    .select("trip_id, tranche_id, credit_from, amount, confirmed_at, deleted_at")
    .eq("id", parsed.data.transaction_id)
    .maybeSingle();
  if (!tx || tx.deleted_at) return { status: "error", message: "Buchung nicht gefunden." };
  if (!tx.tranche_id) return { status: "error", message: "Keine Anzahlungsbuchung." };
  if (tx.confirmed_at) return { status: "error", message: "Schon bestätigt." };

  // Vorstrecker darf bestätigen — er sieht den Geldeingang auf seinem Konto.
  const auth = await requireSkipperAdminOrAdvancer(tx.trip_id);
  if (!auth.ok) return { status: "error", message: auth.message };

  const archivedCheck = await assertTripNotArchived(supabase, tx.trip_id);
  if (!archivedCheck.ok) return { status: "error", message: archivedCheck.message };

  const { error } = await supabase
    .from("transactions")
    .update({ confirmed_at: new Date().toISOString() })
    .eq("id", parsed.data.transaction_id);
  if (error) return { status: "error", message: dbErr(error, "Bestätigung fehlgeschlagen.") };

  await logAudit(supabase, {
    table_name: "transactions",
    operation: "UPDATE",
    record_id: parsed.data.transaction_id,
    trip_id: tx.trip_id,
    actor_person_id: auth.personId,
    payload: { kind: "self-payment-confirmed" },
  });

  // Info-Mails verschicken (best-effort, blockiert die Action nicht).
  try {
    await sendPrepaymentNoticeMails(supabase, {
      tripId: tx.trip_id,
      trancheId: tx.tranche_id!,
      kind: "payment_confirmed",
      actorPersonId: auth.personId,
      subjectPersonId: tx.credit_from,
      amount: Number(tx.amount),
    });
  } catch (e) {
    console.error("[bordkasse:notice-mail]", e);
  }

  // Push an die Crewperson (additiv) — Actor (Vorstrecker/Admin) ausgenommen.
  await sendPushToPersons(
    supabase,
    pushRecipients([tx.credit_from], { excludeActorId: auth.personId }),
    paymentConfirmedPush({ amount: Number(tx.amount), tripId: tx.trip_id }),
  );

  revalidatePath(`/trips/${tx.trip_id}/prepayments`);
  revalidatePath(`/trips/${tx.trip_id}/balance`);
  revalidatePath(`/trips/${tx.trip_id}/transactions`);
  return { status: "ok" };
}

/**
 * Skipper lehnt eine selbst gemeldete Anzahlung ab — Soft-Delete via
 * deleted_at. Crewmitglied bekommt (laut Spec) keine freitext-Antwort,
 * Klärung läuft per WhatsApp. TODO Phase 2 + 1: optional Mail-Notif.
 */
export async function rejectSelfPayment(
  _prev: PrepaymentState,
  formData: FormData,
): Promise<PrepaymentState> {
  const person = await getCurrentPerson();
  if (!person) return { status: "error", message: "Nicht angemeldet." };

  const parsed = ConfirmRejectSchema.safeParse({ transaction_id: formData.get("transaction_id") });
  if (!parsed.success) return { status: "error", message: "Ungültige Buchungs-ID." };

  const supabase = createAdminClient();
  const { data: tx } = await supabase
    .from("transactions")
    .select("trip_id, tranche_id, credit_from, amount, deleted_at, confirmed_at")
    .eq("id", parsed.data.transaction_id)
    .maybeSingle();
  if (!tx || tx.deleted_at) return { status: "error", message: "Buchung nicht gefunden." };
  if (tx.confirmed_at) return { status: "error", message: "Schon bestätigt, kann nicht mehr abgelehnt werden." };

  // Vorstrecker darf ablehnen — er sieht das Geld NICHT auf seinem Konto.
  const auth = await requireSkipperAdminOrAdvancer(tx.trip_id);
  if (!auth.ok) return { status: "error", message: auth.message };

  const archivedCheck = await assertTripNotArchived(supabase, tx.trip_id);
  if (!archivedCheck.ok) return { status: "error", message: archivedCheck.message };

  const { error } = await supabase
    .from("transactions")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", parsed.data.transaction_id);
  if (error) return { status: "error", message: dbErr(error, "Ablehnen fehlgeschlagen.") };

  await logAudit(supabase, {
    table_name: "transactions",
    operation: "DELETE",
    record_id: parsed.data.transaction_id,
    trip_id: tx.trip_id,
    actor_person_id: auth.personId,
    payload: { kind: "self-payment-rejected" },
  });

  // Dedup-Log-Eintrag für diese Tranche × Person löschen, damit der
  // Cron einen korrigierten Reminder verschicken kann — die Person
  // hat jetzt wieder offene Schuld und braucht eine neue Mahnung.
  if (tx.tranche_id && tx.credit_from) {
    await supabase
      .from("prepayment_reminder_log")
      .delete()
      .eq("tranche_id", tx.tranche_id)
      .eq("person_id", tx.credit_from)
      .eq("reminder_type", "crew_3d");
  }

  // Info-Mails (Vorstrecker + Crewperson) — best-effort.
  try {
    await sendPrepaymentNoticeMails(supabase, {
      tripId: tx.trip_id,
      trancheId: tx.tranche_id!,
      kind: "payment_rejected",
      actorPersonId: auth.personId,
      subjectPersonId: tx.credit_from,
      amount: Number(tx.amount),
    });
  } catch (e) {
    console.error("[bordkasse:notice-mail]", e);
  }

  // Push an die Crewperson (additiv) — Actor (Vorstrecker/Admin) ausgenommen.
  await sendPushToPersons(
    supabase,
    pushRecipients([tx.credit_from], { excludeActorId: auth.personId }),
    paymentRejectedPush({ amount: Number(tx.amount), tripId: tx.trip_id }),
  );

  revalidatePath(`/trips/${tx.trip_id}/prepayments`);
  return { status: "ok" };
}

// ════════════════════════════════════════════════════════════════════════
// Notice-Mail-Helper — verschickt Info-Mails bei Anzahlungs-Aktionen, die
// von einer DRITTEN Person ausgelöst werden (Admin/Skipper/Vorstrecker).
//
// Empfänger:
//   - payment_recorded   → Crewperson (Subject) + Vorstrecker (sofern ≠ Actor)
//   - payment_confirmed  → Vorstrecker (sofern ≠ Actor)
//   - payment_rejected   → Crewperson + Vorstrecker (sofern ≠ Actor)
//
// Self-Aktionen (Actor == Crewperson ODER Actor == Vorstrecker bei
// Confirm/Reject) erzeugen KEINE Notice-Mail an die handelnde Person.
//
// Fehler beim Versand blockieren die Action nicht.
// ════════════════════════════════════════════════════════════════════════

async function sendPrepaymentNoticeMails(
  supabase: ReturnType<typeof createAdminClient>,
  args: {
    tripId: string;
    trancheId: string;
    kind: "payment_recorded" | "payment_confirmed" | "payment_rejected";
    actorPersonId: string;
    subjectPersonId: string;
    amount: number;
  },
): Promise<void> {
  const SITE_URL = appOrigin();

  const [{ data: trip }, { data: plan }, { data: tranche }] = await Promise.all([
    supabase.from("trips").select("name, skipper_id, trip_type").eq("id", args.tripId).maybeSingle(),
    supabase
      .from("prepayment_plan")
      .select("advancer_person_id")
      .eq("trip_id", args.tripId)
      .maybeSingle(),
    supabase
      .from("prepayment_tranches")
      .select("label")
      .eq("id", args.trancheId)
      .maybeSingle(),
  ]);
  if (!trip || !tranche) return;
  const tripType: "sailing" | "other" = trip.trip_type === "other" ? "other" : "sailing";
  const advancerPersonId = plan?.advancer_person_id ?? trip.skipper_id;

  // Empfänger-Set: je nach Aktionsart.
  const recipientIds = new Set<string>();
  if (args.kind === "payment_recorded" || args.kind === "payment_rejected") {
    recipientIds.add(args.subjectPersonId);
  }
  recipientIds.add(advancerPersonId);
  // Actor sieht keine Notice über die eigene Aktion.
  recipientIds.delete(args.actorPersonId);
  if (recipientIds.size === 0) return;

  const allIds = Array.from(
    new Set([
      ...recipientIds,
      args.actorPersonId,
      args.subjectPersonId,
      advancerPersonId,
    ]),
  );

  const [{ data: personsRaw }, { data: privsRaw }] = await Promise.all([
    supabase.from("persons").select("id, display_name").in("id", allIds),
    supabase
      .from("persons_private")
      .select("person_id, email")
      .in("person_id", Array.from(recipientIds)),
  ]);
  const nameById = new Map<string, string>();
  for (const p of personsRaw ?? []) nameById.set(p.id, p.display_name);
  const emailById = new Map<string, string>();
  for (const p of privsRaw ?? []) if (p.email) emailById.set(p.person_id, p.email);

  const actorName = nameById.get(args.actorPersonId) ?? "Skipper";
  const subjectPersonName = nameById.get(args.subjectPersonId) ?? "Crewmitglied";
  const advancerName = nameById.get(advancerPersonId) ?? "die vorstreckende Person";

  const { renderPrepaymentNoticeMail } = await import(
    "@/lib/email/prepayment-notice-template"
  );
  const { sendMail } = await import("@/lib/email/send");

  for (const personId of recipientIds) {
    const email = emailById.get(personId);
    if (!email) continue;
    const recipientName = nameById.get(personId) ?? "Crewmitglied";
    const isAdvancer = personId === advancerPersonId;

    const mail = renderPrepaymentNoticeMail({
      kind: args.kind,
      recipientName,
      actorName,
      subjectPersonName,
      advancerName: isAdvancer ? undefined : advancerName,
      amount: args.amount,
      trancheLabel: tranche.label,
      tripName: trip.name,
      appUrl: `${SITE_URL}/trips/${args.tripId}/prepayments`,
      tripType,
    });

    const res = await sendMail({
      to: email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
    if (!res.ok) {
      console.error("[bordkasse:notice-mail] failed", {
        person_id: personId,
        kind: args.kind,
        error: res.error,
      });
    }
  }
}
