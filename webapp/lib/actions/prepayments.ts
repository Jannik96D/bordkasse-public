"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { requireSkipperOrAdmin, requireMember } from "@/lib/auth/authz";
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
 * Berechnet ggf. Obligations automatisch aus Aufteilungs-Methode + Trip-Crew.
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
    if (obErr) return { status: "error", message: dbErr(obErr, "Soll-Beträge konnten nicht gespeichert werden.") };
  }

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
    if (t.id) {
      await supabase.from("prepayment_tranches").update(row).eq("id", t.id);
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

  const auth = await requireSkipperOrAdmin(trip_id);
  if (!auth.ok) return { status: "error", message: auth.message };

  const supabase = createAdminClient();

  // Vorstrecker ermitteln: aus prepayment_plan.advancer_person_id, sonst
  // Trip-Skipper als Fallback. Crew-Anzahlungen werden gegen diese Person
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
        idempotency_key: idemKey,
      });
    if (error && !(error.code === PG_UNIQUE_VIOLATION && idemKey)) {
      throw error;
    }
  }

  try {
    if (splitOverflow) {
      const part1 = Math.max(0, Math.min(open, amount));
      const part2 = amount - part1;
      if (part1 > 0) await insertCredit(tranche_id, round2(part1), idempotency_key);
      if (part2 > 0) await insertCredit(overflow_tranche_id!, round2(part2));
    } else {
      await insertCredit(tranche_id, amount, idempotency_key);
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

  revalidatePath(`/trips/${trip_id}/prepayments`);
  revalidatePath(`/trips/${trip_id}/balance`);
  revalidatePath(`/trips/${trip_id}/transactions`);
  return { status: "ok" };
}

// ────────────────────────────────────────────────────────────────────────
// 4. Crew-Wechsel: A → B
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
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe." };
  }
  const { trip_id, old_person_id, new_display_name, new_email } = parsed.data;

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

  // 2. Neue Person anlegen (oder bestehende per E-Mail nachladen)
  let newPersonId: string;
  if (new_email) {
    const { data: existingPriv } = await supabase
      .from("persons_private")
      .select("person_id")
      .ilike("email", new_email)
      .maybeSingle();
    if (existingPriv) {
      newPersonId = existingPriv.person_id;
    } else {
      const { data: created, error } = await supabase
        .from("persons")
        .insert({ display_name: new_display_name })
        .select("id")
        .single();
      if (error || !created) return { status: "error", message: dbErr(error, "Person konnte nicht angelegt werden.") };
      newPersonId = created.id;
      await supabase.from("persons_private").insert({ person_id: newPersonId, email: new_email });
    }
  } else {
    // Ghost-Person ohne E-Mail
    const { data: created, error } = await supabase
      .from("persons")
      .insert({ display_name: new_display_name })
      .select("id")
      .single();
    if (error || !created) return { status: "error", message: dbErr(error, "Person konnte nicht angelegt werden.") };
    newPersonId = created.id;
  }

  // 3. Neue Person als Crew anlegen (übernimmt Daten von A — Koje, Anwesenheit)
  const { data: oldMember } = await supabase
    .from("trip_members")
    .select("id, on_board_from, on_board_to, is_alcoholic, note")
    .eq("trip_id", trip_id)
    .eq("person_id", old_person_id)
    .maybeSingle();
  if (!oldMember) return { status: "error", message: "Alte Crew-Person nicht gefunden." };

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
  if (tmErr || !newMember) return { status: "error", message: dbErr(tmErr, "Crew-Eintrag konnte nicht angelegt werden.") };

  // 4. Obligation von A auf B übertragen (Cabin bleibt)
  const { data: oldObl } = await supabase
    .from("prepayment_obligations")
    .select("cabin_type_id, total_amount")
    .eq("trip_id", trip_id)
    .eq("person_id", old_person_id)
    .maybeSingle();
  if (oldObl) {
    await supabase.from("prepayment_obligations").delete()
      .eq("trip_id", trip_id).eq("person_id", old_person_id);
    await supabase.from("prepayment_obligations").upsert(
      {
        trip_id,
        person_id: newPersonId,
        cabin_type_id: oldObl.cabin_type_id,
        total_amount: oldObl.total_amount,
      },
      { onConflict: "trip_id,person_id" },
    );
  }

  // 5. Bisher gezahlte Anzahlungs-Gutschriften von A:
  //    Pro Eintrag erzeugen wir eine Gegen-Gutschrift "B → A" (B hat A privat ausgezahlt),
  //    sodass B bilanziell in A's Position rutscht und A's Saldo auf 0 geht.
  const { data: oldPayments } = await supabase
    .from("transactions")
    .select("id, tranche_id, amount, date")
    .eq("trip_id", trip_id)
    .eq("credit_from", old_person_id)
    .eq("type", "credit")
    .not("tranche_id", "is", null)
    .is("deleted_at", null);

  let transferredSum = 0;
  for (const p of oldPayments ?? []) {
    await supabase.from("transactions").insert({
      trip_id,
      type: "credit",
      date: p.date,
      description: `Crew-Wechsel: ${new_display_name} übernimmt Anzahlung`,
      amount: p.amount,
      credit_from: newPersonId,
      credit_to: old_person_id,
      tranche_id: null,
      created_by: person.id,
    });
    transferredSum += Number(p.amount);
  }

  // 6. A "abreisen lassen" — Anwesenheit auf null, bleibt aber im trip_members
  //    für Audit. Bei aktiven Buchungen wäre Löschen sowieso geblockt.
  await supabase
    .from("trip_members")
    .update({ on_board_from: null, on_board_to: null, note: `Ersetzt durch ${new_display_name}` })
    .eq("id", oldMember.id);

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

  // Optional: Magic-Link für neue Person, falls E-Mail
  if (new_email) {
    try {
      const hdrs = await headers();
      const origin = resolveOrigin(hdrs.get("origin"));
      await sendInvitationMagicLink(new_email, origin);
    } catch (e) {
      console.error("[bordkasse:invite]", e);
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

  const auth = await requireSkipperOrAdmin(parsed.data.trip_id);
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

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function daysBetween(fromIso: string, toIso: string): number {
  if (!fromIso || !toIso) return 0;
  const from = new Date(`${fromIso}T00:00:00Z`);
  const to = new Date(`${toIso}T00:00:00Z`);
  const diff = Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 1;
  return Math.max(0, diff);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Stilles Import zur Vermeidung von "unused"-Warnings (redirect/requireMember
// werden in zukünftigen Phase-2-Erweiterungen gebraucht).
void redirect;
void requireMember;
