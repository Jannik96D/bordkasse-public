"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSkipperOrAdmin } from "@/lib/auth/authz";
import { logAudit } from "@/lib/db/audit";
import { sendInvitationMagicLink } from "@/lib/auth/invite";
import { resolveOrigin } from "@/lib/auth/origin";

const InviteSchema = z.object({
  trip_id: z.string().uuid(),
  // E-Mail ist optional, damit der Skipper Crew anlegen kann, ohne sie zu kennen.
  // Ohne E-Mail kann sich die Person nicht einloggen, taucht aber in der App
  // als „Ghost"-Person auf — Soll-Zuordnung, Buchungs-Beteiligung und
  // WhatsApp-Texte funktionieren trotzdem.
  email: z.string().trim().email("Bitte gültige E-Mail-Adresse eingeben.").optional().or(z.literal("")),
  display_name: z.string().trim().min(2).max(60).optional().or(z.literal("")),
  on_board_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  on_board_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  is_alcoholic: z.string().optional(),
  note: z.string().max(200).optional().or(z.literal("")),
}).refine(
  (d) => !!d.email || (d.display_name && d.display_name.length >= 2),
  { message: "Entweder E-Mail oder Anzeigename angeben.", path: ["email"] },
);

export type MemberState =
  | { status: "idle" }
  | { status: "ok" }
  | { status: "error"; message: string };

export async function inviteMember(_prev: MemberState, formData: FormData): Promise<MemberState> {
  const parsed = InviteSchema.safeParse({
    trip_id: formData.get("trip_id"),
    email: formData.get("email"),
    display_name: formData.get("display_name") || "",
    on_board_from: formData.get("on_board_from") || "",
    on_board_to: formData.get("on_board_to") || "",
    is_alcoholic: formData.get("is_alcoholic")?.toString(),
    note: formData.get("note") || "",
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe." };
  }

  const { trip_id, email, display_name, on_board_from, on_board_to, is_alcoholic, note } = parsed.data;

  const auth = await requireSkipperOrAdmin(trip_id);
  if (!auth.ok) return { status: "error", message: auth.message };

  const supabase = createAdminClient();

  // Person mit dieser E-Mail finden (über persons_private) oder als Ghost
  // anlegen. E-Mail liegt seit Migration 0013 ausschließlich in
  // persons_private — persons selbst hat sie nicht mehr.
  // Sonderfall ohne E-Mail: direkt neue Ghost-Person (kein persons_private-Eintrag).
  let personId: string;
  if (email) {
    const { data: existingPriv } = await supabase
      .from("persons_private")
      .select("person_id")
      .ilike("email", email)
      .maybeSingle();

    if (existingPriv) {
      personId = existingPriv.person_id;
    } else {
      const fallbackName = display_name || email.split("@")[0];
      const { data: created, error } = await supabase
        .from("persons")
        .insert({ display_name: fallbackName })
        .select("id")
        .single();
      if (error || !created) {
        if (error?.message) console.error("[bordkasse:db]", error.message);
        return { status: "error", message: "Person konnte nicht angelegt werden. Bitte erneut versuchen." };
      }
      personId = created.id;
      const { error: privErr } = await supabase
        .from("persons_private")
        .insert({ person_id: personId, email });
      if (privErr) {
        return { status: "error", message: privErr.message };
      }
    }
  } else {
    // Ghost ohne E-Mail: nur persons-Row, kein persons_private.
    const { data: created, error } = await supabase
      .from("persons")
      .insert({ display_name: display_name! })
      .select("id")
      .single();
    if (error || !created) {
      if (error?.message) console.error("[bordkasse:db]", error.message);
      return { status: "error", message: "Person konnte nicht angelegt werden. Bitte erneut versuchen." };
    }
    personId = created.id;
  }

  // Vorab prüfen ob Person schon Mitglied — entscheidet, ob die
  // Einladungs-Mail rausgeht. Bei reinem UPSERT-Update (Anwesenheits-
  // Edit etc.) wollen wir den Eingeladenen NICHT erneut anschreiben.
  const { data: existingMember } = await supabase
    .from("trip_members")
    .select("id")
    .eq("trip_id", trip_id)
    .eq("person_id", personId)
    .maybeSingle();
  const wasAlreadyMember = !!existingMember;

  // Mitgliedschaft anlegen (UPSERT auf trip_id+person_id)
  const alkInput = is_alcoholic;
  const isAlcoholic =
    alkInput === "yes" ? true :
    alkInput === "no" ? false :
    null;

  const { data: member, error: tmError } = await supabase
    .from("trip_members")
    .upsert(
      {
        trip_id,
        person_id: personId,
        on_board_from: on_board_from || null,
        on_board_to: on_board_to || null,
        is_alcoholic: isAlcoholic,
        note: note || null,
      },
      { onConflict: "trip_id,person_id" },
    )
    .select()
    .single();

  if (tmError) return { status: "error", message: tmError.message };

  if (member) {
    await logAudit(supabase, {
      table_name: "trip_members",
      operation: "INSERT",
      record_id: member.id,
      trip_id,
      actor_person_id: auth.personId,
      payload: member,
    });
  }

  // Einladungs-Mail nur bei NEUER Mitgliedschaft UND vorhandener E-Mail.
  // Fehler beim Mail-Versand werden geloggt, blocken aber nicht.
  if (!wasAlreadyMember && email) {
    const hdrs = await headers();
    const origin = resolveOrigin(hdrs.get("origin"));
    await sendInvitationMagicLink(email, origin);
  }

  revalidatePath(`/trips/${trip_id}/settings`);
  revalidatePath(`/trips/${trip_id}`);
  return { status: "ok" };
}

export async function removeMember(
  memberId: string,
  tripId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const auth = await requireSkipperOrAdmin(tripId);
  if (!auth.ok) return { ok: false, message: auth.message };
  const supabase = createAdminClient();

  const [{ data: tripRow }, { data: memberRow }] = await Promise.all([
    supabase.from("trips").select("skipper_id").eq("id", tripId).maybeSingle(),
    supabase.from("trip_members").select("person_id").eq("id", memberId).maybeSingle(),
  ]);
  if (!memberRow) return { ok: false, message: "Crew-Mitglied nicht gefunden." };

  // Original-Owner darf niemand entfernen — sonst hätte der Trip keinen
  // "letzten Skipper" mehr, falls auch alle Co-Skipper weg sind.
  if (tripRow && tripRow.skipper_id === memberRow.person_id) {
    return {
      ok: false,
      message: "Der ursprüngliche Skipper kann nicht aus dem Törn entfernt werden.",
    };
  }

  // Person hat noch (nicht-soft-deleted) Buchungen → entfernen würde die
  // Bilanz inkonsistent machen (Bezahlt/Anteil-Summe ≠ 0). Skipper soll
  // erst die Buchungen umbuchen oder stornieren.
  const personId = memberRow.person_id;
  const { count: txCount } = await supabase
    .from("transactions")
    .select("*", { count: "exact", head: true })
    .eq("trip_id", tripId)
    .is("deleted_at", null)
    .or(`paid_by.eq.${personId},credit_from.eq.${personId},credit_to.eq.${personId}`);
  if ((txCount ?? 0) > 0) {
    return {
      ok: false,
      message:
        "Diese Person hat noch Buchungen in diesem Törn. Bitte erst die Buchungen umbuchen (paid_by ändern) oder löschen, bevor du sie entfernst.",
    };
  }

  await supabase.from("trip_members").delete().eq("id", memberId);
  await logAudit(supabase, {
    table_name: "trip_members",
    operation: "DELETE",
    record_id: memberId,
    trip_id: tripId,
    actor_person_id: auth.personId,
  });
  revalidatePath(`/trips/${tripId}/settings`);
  revalidatePath(`/trips/${tripId}`);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────
// Skipper-Rolle umschalten + Crew-Member-Daten editieren
// ─────────────────────────────────────────────────────────────────────────

const UpdateMemberSchema = z.object({
  member_id: z.string().uuid(),
  trip_id: z.string().uuid(),
  display_name: z.string().trim().min(2).max(60).optional().or(z.literal("")),
  email: z.string().trim().email("Bitte gültige E-Mail-Adresse eingeben.").optional().or(z.literal("")),
  on_board_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  on_board_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  is_alcoholic: z.string().optional(),
  note: z.string().max(200).optional().or(z.literal("")),
});

/**
 * Update einer Crew-Person:
 *   - on_board_from/to, is_alcoholic, note  → trip_members
 *   - display_name + email                  → persons (nur für Ghost-Personen,
 *                                             damit nicht versehentlich die
 *                                             globalen Profil-Daten eines
 *                                             eingeloggten Users überschrieben
 *                                             werden)
 */
export async function updateMember(_prev: MemberState, formData: FormData): Promise<MemberState> {
  const parsed = UpdateMemberSchema.safeParse({
    member_id: formData.get("member_id"),
    trip_id: formData.get("trip_id"),
    display_name: formData.get("display_name") || "",
    email: formData.get("email") || "",
    on_board_from: formData.get("on_board_from") || "",
    on_board_to: formData.get("on_board_to") || "",
    is_alcoholic: formData.get("is_alcoholic")?.toString(),
    note: formData.get("note") || "",
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe." };
  }
  const { member_id, trip_id, display_name, email, on_board_from, on_board_to, is_alcoholic, note } = parsed.data;

  const auth = await requireSkipperOrAdmin(trip_id);
  if (!auth.ok) return { status: "error", message: auth.message };

  const supabase = createAdminClient();

  // Member + zugehörige Person holen — wir brauchen person_id + Ghost-Status.
  const { data: member } = await supabase
    .from("trip_members")
    .select("person_id, persons!inner(auth_user_id)")
    .eq("id", member_id)
    .eq("trip_id", trip_id)
    .maybeSingle();
  if (!member) return { status: "error", message: "Crew-Mitglied nicht gefunden." };

  const personRel = (member as unknown as { persons: { auth_user_id: string | null } | { auth_user_id: string | null }[] }).persons;
  const personFlat = Array.isArray(personRel) ? personRel[0] : personRel;
  const isGhost = personFlat?.auth_user_id == null;

  const isAlcoholic =
    is_alcoholic === "yes" ? true :
    is_alcoholic === "no" ? false :
    null;

  // 1. trip_members-Felder
  const { error: tmError } = await supabase
    .from("trip_members")
    .update({
      on_board_from: on_board_from || null,
      on_board_to: on_board_to || null,
      is_alcoholic: isAlcoholic,
      note: note || null,
    })
    .eq("id", member_id);
  if (tmError) return { status: "error", message: tmError.message };

  await logAudit(supabase, {
    table_name: "trip_members",
    operation: "UPDATE",
    record_id: member_id,
    trip_id,
    actor_person_id: auth.personId,
    payload: { on_board_from, on_board_to, is_alcoholic: isAlcoholic, note },
  });

  // 2. persons-Felder — nur bei Ghost (kein Auth-User), und nur falls Werte gesetzt
  if (isGhost && (display_name || email)) {
    if (display_name) {
      const { error: pError } = await supabase
        .from("persons")
        .update({ display_name })
        .eq("id", member.person_id);
      if (pError) return { status: "error", message: pError.message };
      await logAudit(supabase, {
        table_name: "persons",
        operation: "UPDATE",
        record_id: member.person_id,
        trip_id,
        actor_person_id: auth.personId,
        payload: { display_name },
      });
    }
    if (email) {
      // Vorher prüfen, ob das ein NEU eingetragene E-Mail (vorher keine
      // private-Row) → dann nach dem Upsert eine Einladungs-Mail schicken.
      const { data: priorPriv } = await supabase
        .from("persons_private")
        .select("email")
        .eq("person_id", member.person_id)
        .maybeSingle();
      const isFirstEmail = !priorPriv?.email;

      // Gehört die E-Mail bereits einer anderen Person? Dann würde der
      // Upsert mit der unique-constraint auf persons_private.email kollidieren.
      // Stattdessen geben wir eine sinnvolle Meldung zurück: die andere Person
      // ist wahrscheinlich der „echte" Eintrag — der Skipper sollte den
      // aktuellen Ghost-Eintrag löschen und stattdessen den vorhandenen
      // Account einladen.
      const { data: emailInUse } = await supabase
        .from("persons_private")
        .select("person_id, persons!inner(display_name)")
        .ilike("email", email)
        .neq("person_id", member.person_id)
        .maybeSingle();
      if (emailInUse) {
        const otherRel = (emailInUse as unknown as { persons: { display_name: string } | { display_name: string }[] }).persons;
        const otherName = (Array.isArray(otherRel) ? otherRel[0] : otherRel)?.display_name ?? "anderem Crew-Mitglied";
        return {
          status: "error",
          message: `Diese E-Mail gehört bereits zu „${otherName}". Lösche dieses Crew-Mitglied und füge stattdessen ${otherName} über „Crew hinzufügen" mit dieser E-Mail neu hinzu.`,
        };
      }

      // E-Mail liegt in persons_private — upsert, weil Ghost evtl.
      // noch keine private-Row hat.
      const { error: privError } = await supabase
        .from("persons_private")
        .upsert({ person_id: member.person_id, email }, { onConflict: "person_id" });
      if (privError) return { status: "error", message: privError.message };
      await logAudit(supabase, {
        table_name: "persons_private",
        operation: "UPDATE",
        record_id: member.person_id,
        trip_id,
        actor_person_id: auth.personId,
        payload: { email },
      });

      if (isFirstEmail) {
        try {
          const hdrs = await headers();
          const origin = resolveOrigin(hdrs.get("origin"));
          await sendInvitationMagicLink(email, origin);
        } catch (e) {
          console.error("[bordkasse:invite-on-edit]", e);
        }
      }
    }
  }

  revalidatePath(`/trips/${trip_id}/settings`);
  revalidatePath(`/trips/${trip_id}`);
  return { status: "ok" };
}

/**
 * Skipper-Rolle einer Person umschalten. Der Original-Owner
 * (trips.skipper_id) kann nicht degradiert werden.
 */
export async function setSkipperRole(memberId: string, tripId: string, isSkipper: boolean) {
  const auth = await requireSkipperOrAdmin(tripId);
  if (!auth.ok) return;
  const supabase = createAdminClient();

  const [{ data: tripRow }, { data: memberRow }] = await Promise.all([
    supabase.from("trips").select("skipper_id").eq("id", tripId).maybeSingle(),
    supabase.from("trip_members").select("person_id").eq("id", memberId).maybeSingle(),
  ]);
  if (!tripRow || !memberRow) return;
  // Original-Owner kann nicht von der Skipper-Rolle entbunden werden.
  if (!isSkipper && tripRow.skipper_id === memberRow.person_id) return;

  await supabase.from("trip_members").update({ is_skipper: isSkipper }).eq("id", memberId);
  await logAudit(supabase, {
    table_name: "trip_members",
    operation: "UPDATE",
    record_id: memberId,
    trip_id: tripId,
    actor_person_id: auth.personId,
    payload: { is_skipper: isSkipper },
  });
  revalidatePath(`/trips/${tripId}/settings`);
  revalidatePath(`/trips/${tripId}`);
}
