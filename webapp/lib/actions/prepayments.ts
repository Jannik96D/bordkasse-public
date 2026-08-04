"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { requireSkipperOrAdmin, requireMember, requireSkipperAdminOrAdvancer } from "@/lib/auth/authz";
import { sendPushToPersons } from "@/lib/notify/web-push";
import { pushRecipients } from "@/lib/notify/recipients";
import { paymentPendingPush, paymentConfirmedPush, paymentRejectedPush } from "@/lib/notify/payloads";
import { personsBelongToTrip, trancheBelongsToTrip, CROSS_TRIP_PERSON_MSG } from "@/lib/auth/cross-trip";
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
import { resolveOrigin } from "@/lib/auth/origin";
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
  const { data: existingCabins } = await supabase
    .from("cabin_types")
    .select("id")
    .eq("trip_id", trip_id);
  const existingCabinIds = new Set((existingCabins ?? []).map((c) => c.id as string));
  const incomingCabinIds = new Set(cabin_types.filter((c) => c.id).map((c) => c.id as string));

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
    // Crew laden + Tage berechnen
    const { data: members } = await supabase
      .from("trip_members")
      .select("person_id, on_board_from, on_board_to")
      .eq("trip_id", trip_id);
    const { data: tripRow } = await supabase
      .from("trips")
      .select("start_date, end_date")
      .eq("id", trip_id)
      .single();
    const tripStart = tripRow?.start_date ?? "";
    const tripEnd = tripRow?.end_date ?? "";

    const calcMembers: PrepaymentMember[] = (members ?? []).map((m) => {
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
    const { data: freshCabins } = await supabase
      .from("cabin_types")
      .select("id, price_per_person, capacity")
      .eq("trip_id", trip_id);
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

  // Bereits gezahlt
  const { data: paidRows } = await supabase
    .from("transactions")
    .select("amount")
    .eq("trip_id", trip_id)
    .eq("tranche_id", tranche_id)
    .eq("credit_from", person_id)
    .eq("type", "credit")
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
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe." };
  }
  const { trip_id, old_person_id, new_display_name, new_email } = parsed.data;
  // Fund 3 (Idempotency, Grill-Review): ohne clientseitig stabile ID würde
  // ein Netzwerk-Retry (Yacht-WLAN — siehe 0005_idempotency.sql) die neue
  // Person, den Anzahlungs-Transfer und die Gegen-Gutschrift duplizieren.
  // Fallback nur zur Absicherung gegen einen Client ohne dieses Feld — dann
  // ist der jeweilige Aufruf einfach nicht idempotent, wie bisher.
  const effectiveNewPersonId = parsed.data.new_person_id ?? crypto.randomUUID();
  // Name optional: fehlt er, aus der E-Mail ableiten. Das Schema-Refine
  // garantiert, dass mindestens eins von beidem gesetzt ist.
  const effectiveName = new_display_name || displayNameFromEmail(new_email);

  const auth = await requireSkipperOrAdmin(trip_id);
  if (!auth.ok) return { status: "error", message: auth.message };

  const supabase = createAdminClient();

  // 1. Original-Skipper darf nicht ersetzt werden (Audit-Spur)
  const { data: tripRow } = await supabase
    .from("trips")
    .select("skipper_id")
    .eq("id", trip_id)
    .maybeSingle();
  if (!tripRow) return { status: "error", message: "Törn nicht gefunden." };
  if (tripRow.skipper_id === old_person_id) {
    return { status: "error", message: "Der ursprüngliche Skipper kann nicht ersetzt werden." };
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
      // upsert-by-id statt insert: mit stabiler effectiveNewPersonId ist ein
      // Retry (verlorene Antwort bei flakey Yacht-WLAN) idempotent — legt
      // dieselbe Person nicht zweimal an (Fund 3).
      const { data: created, error } = await supabase
        .from("persons")
        .upsert({ id: effectiveNewPersonId, display_name: effectiveName }, { onConflict: "id" })
        .select("id")
        .single();
      if (error || !created) return { status: "error", message: dbErr(error, "Person konnte nicht angelegt werden.") };
      newPersonId = created.id;
      const { error: privErr } = await supabase
        .from("persons_private")
        .upsert({ person_id: newPersonId, email: new_email }, { onConflict: "person_id" });
      if (privErr) return { status: "error", message: dbErr(privErr, "E-Mail konnte nicht gespeichert werden.") };
    }
  } else {
    // Ghost-Person ohne E-Mail — ebenfalls upsert-by-id (Fund 3).
    const { data: created, error } = await supabase
      .from("persons")
      .upsert({ id: effectiveNewPersonId, display_name: effectiveName }, { onConflict: "id" })
      .select("id")
      .single();
    if (error || !created) return { status: "error", message: dbErr(error, "Person konnte nicht angelegt werden.") };
    newPersonId = created.id;
  }

  // 4. Neue Person als Crew anlegen (übernimmt Daten von A — Koje, Anwesenheit)
  const { data: oldMember } = await supabase
    .from("trip_members")
    .select("id, on_board_from, on_board_to, is_alcoholic, note")
    .eq("trip_id", trip_id)
    .eq("person_id", old_person_id)
    .maybeSingle();
  if (!oldMember) return { status: "error", message: "Alte Crewperson nicht gefunden." };

  const { data: newMember, error: tmErr } = await supabase
    .from("trip_members")
    .upsert(
      {
        trip_id,
        person_id: newPersonId,
        on_board_from: oldMember.on_board_from,
        on_board_to: oldMember.on_board_to,
        is_alcoholic: oldMember.is_alcoholic,
        note: oldMember.note,
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

  // 6. Bisher gezahlte Anzahlungs-Gutschriften von A:
  //    Pro Eintrag erzeugen wir eine Gegen-Gutschrift "B → A" (B hat A privat ausgezahlt),
  //    sodass B bilanziell in A's Position rutscht und A's Saldo auf 0 geht.
  //    Nur BESTÄTIGTE Zahlungen (confirmed_at IS NOT NULL, wie v_prepayment_payments) —
  //    eine unbestätigte Selbstmeldung ist noch kein echter Zahlungseingang (der Pre-Check
  //    oben blockt den Wechsel ohnehin, solange eine solche offen ist).
  const { data: oldPayments } = await supabase
    .from("transactions")
    .select("id, tranche_id, amount, date")
    .eq("trip_id", trip_id)
    .eq("credit_from", old_person_id)
    .eq("type", "credit")
    .not("tranche_id", "is", null)
    .not("confirmed_at", "is", null)
    .is("deleted_at", null);

  let transferredSum = 0;
  for (const p of oldPayments ?? []) {
    // Fund 3 (Idempotency) + Grill-Review-Fund: `idempotency_key = p.id`
    // (die ID der QUELL-Zahlung, nicht new_person_id!) statt Check-before-
    // Insert. p.id ist pro Quell-Zahlung eindeutig — ein früherer Ansatz
    // über Betrag+Datum hätte zwei unterschiedliche, zufällig gleich hohe
    // Zahlungen vom selben Tag (z.B. zwei gleich große Tranchen) als
    // "schon übertragen" verwechselt und die zweite Übertragung ausgelassen
    // (Geld verschwindet aus der Bilanz). `idempotency_key` ist UNIQUE
    // (trip_id, idempotency_key) — echte DB-Garantie statt TOCTOU-Race
    // zwischen SELECT und INSERT, exakt das Muster aus recordPayment/
    // insertCredit.
    const { error: transferErr } = await supabase.from("transactions").insert({
      trip_id,
      type: "credit",
      date: p.date,
      description: `Crewwechsel: ${effectiveName} übernimmt Anzahlung`,
      amount: p.amount,
      credit_from: newPersonId,
      credit_to: old_person_id,
      tranche_id: null,
      created_by: person.id,
      idempotency_key: p.id,
    });
    if (transferErr && transferErr.code !== PG_UNIQUE_VIOLATION) {
      return { status: "error", message: dbErr(transferErr, "Zahlungsübertrag fehlgeschlagen.") };
    }
    // Bei Unique-Violation (Retry) ist der Transfer schon passiert — trotzdem
    // mitzählen, sonst würde der Audit-Log-Betrag beim Retry plötzlich 0 zeigen.
    transferredSum += Number(p.amount);
  }

  // 7. A "abreisen lassen" — Anwesenheit auf null, bleibt aber im trip_members
  //    für Audit. Bei aktiven Buchungen wäre Löschen sowieso geblockt.
  const { error: departErr } = await supabase
    .from("trip_members")
    .update({ on_board_from: null, on_board_to: null, note: `Ersetzt durch ${effectiveName}` })
    .eq("id", oldMember.id);
  if (departErr) return { status: "error", message: dbErr(departErr, "Alte Crewperson konnte nicht auf abgereist gesetzt werden.") };

  await logAudit(supabase, {
    table_name: "trip_members",
    operation: "UPDATE",
    record_id: oldMember.id,
    trip_id,
    actor_person_id: person.id,
    payload: {
      kind: "crew-replacement",
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

  revalidatePath(`/trips/${trip_id}/prepayments`);
  revalidatePath(`/trips/${trip_id}/balance`);
  revalidatePath(`/trips/${trip_id}/settings`);
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
  const SITE_URL = process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://bordkasse.dieter.ms";

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
