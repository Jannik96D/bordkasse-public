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

      // Gehört die E-Mail bereits einer anderen Person? Dann versuchen wir
      // automatisch zu mergen: der aktuelle Ghost-Eintrag wird in den
      // bestehenden Account integriert. Nur sicher, wenn der Ghost noch
      // keine Buchungen hat — sonst Risiko von FK-Konflikten.
      const { data: emailInUse } = await supabase
        .from("persons_private")
        .select("person_id, persons!inner(display_name)")
        .ilike("email", email)
        .neq("person_id", member.person_id)
        .maybeSingle();

      if (emailInUse) {
        const mergeResult = await mergeGhostIntoExistingPerson(
          supabase,
          member.person_id,
          emailInUse.person_id,
          trip_id,
          auth.personId,
        );
        if (!mergeResult.ok) return { status: "error", message: mergeResult.message };

        revalidatePath(`/trips/${trip_id}/settings`);
        revalidatePath(`/trips/${trip_id}`);
        return { status: "ok" };
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

/**
 * Ghost-Person in einen bestehenden Account integrieren.
 *
 * Use-Case: Skipper hat eine Person ohne E-Mail angelegt (Ghost) und trägt
 * jetzt eine E-Mail nach, die schon zu einem bestehenden Account gehört.
 * Statt einer harten Fehlermeldung verschmelzen wir die beiden Identitäten
 * automatisch: ALLE Verweise (Buchungen, Anzahlungs-Soll, Trip-Membership,
 * Trip-Skipper-FK) wandern vom Ghost auf den echten Account, dann wird
 * die Ghost-Row gelöscht.
 *
 * Bilanz-neutral: Reassignment ändert keine Beträge, nur die Person, der
 * sie zugeordnet sind. Wenn der Ghost z.B. eine 100€-Ausgabe als paid_by
 * hatte, hat danach die echte Person 100€ ausgelegt — was eh die Realität
 * ist (es ist ja dieselbe Person).
 *
 * Konflikt-Edge-Cases werden defensiv behandelt:
 *   - `transaction_participants` PK (transaction_id, person_id): wenn
 *     Ghost UND real beide an derselben Buchung beteiligt waren, behalten
 *     wir nur die real-Zeile (Summe der Beträge bei per_person)
 *   - `prepayment_obligations` PK (trip_id, person_id): real hat Vorrang,
 *     Ghost-Obligation wird verworfen wenn real schon eine hat
 *   - `trip_members` UNIQUE (trip_id, person_id): real hat Vorrang,
 *     Ghost-Membership wird gelöscht wenn real schon Member ist
 */
async function mergeGhostIntoExistingPerson(
  supabase: ReturnType<typeof createAdminClient>,
  ghostId: string,
  realId: string,
  tripId: string,
  actorPersonId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  // Pre-Check: ist die echte Person bereits Crew-Mitglied DIESES Trips?
  // Dann wäre die Verschmelzung zwar technisch lösbar (Ghost-Membership
  // verwerfen, real-Membership behalten), aber der Skipper hat unbewusst
  // dieselbe Person zweimal eingeladen — er soll bewusst entscheiden,
  // welcher Eintrag bleibt (z.B. wegen abweichender Anwesenheits-Daten
  // oder Kojen-Zuordnung).
  const { data: realMembershipCheck } = await supabase
    .from("trip_members")
    .select("id, person:persons!inner(display_name)")
    .eq("trip_id", tripId)
    .eq("person_id", realId)
    .maybeSingle();
  if (realMembershipCheck) {
    const rel = (realMembershipCheck as unknown as {
      person: { display_name: string } | { display_name: string }[];
    }).person;
    const realName = (Array.isArray(rel) ? rel[0] : rel)?.display_name ?? "diese Person";
    return {
      ok: false,
      message:
        `„${realName}" ist mit dieser E-Mail-Adresse bereits Crew-Mitglied dieses Törns. ` +
        `Lösche entweder den aktuellen Crew-Eintrag (ohne E-Mail) oder den bestehenden „${realName}"-Eintrag, ` +
        `damit die Person nur einmal vorkommt.`,
    };
  }

  // 1. transactions: paid_by / credit_from / credit_to umhängen — keine
  //    Constraints betroffen, einfache UPDATEs.
  await supabase.from("transactions").update({ paid_by: realId }).eq("paid_by", ghostId);
  await supabase.from("transactions").update({ credit_from: realId }).eq("credit_from", ghostId);
  await supabase.from("transactions").update({ credit_to: realId }).eq("credit_to", ghostId);
  await supabase.from("transactions").update({ created_by: realId }).eq("created_by", ghostId);

  // 2. transaction_participants: PK (transaction_id, person_id). Wenn
  //    Ghost+real beide auf der gleichen Buchung waren, behalten wir die
  //    real-Zeile und addieren ggf. den per_person-Betrag des Ghosts dazu.
  const { data: ghostParticipations } = await supabase
    .from("transaction_participants")
    .select("transaction_id, amount")
    .eq("person_id", ghostId);
  for (const gp of ghostParticipations ?? []) {
    const { data: realPart } = await supabase
      .from("transaction_participants")
      .select("amount")
      .eq("transaction_id", gp.transaction_id)
      .eq("person_id", realId)
      .maybeSingle();
    if (realPart) {
      // Doppelte Teilnahme — Ghost-Eintrag verwerfen.
      // Bei per_person addieren wir den Ghost-Betrag aufs real-Konto (sonst
      // würde Σ(participant.amount) plötzlich kleiner als transaction.amount).
      if (gp.amount != null && realPart.amount != null) {
        await supabase
          .from("transaction_participants")
          .update({ amount: Number(realPart.amount) + Number(gp.amount) })
          .eq("transaction_id", gp.transaction_id)
          .eq("person_id", realId);
      } else if (gp.amount != null && realPart.amount == null) {
        // real war individual-Teilnehmer ohne Betrag, Ghost war per_person mit Betrag — behalte den Betrag
        await supabase
          .from("transaction_participants")
          .update({ amount: gp.amount })
          .eq("transaction_id", gp.transaction_id)
          .eq("person_id", realId);
      }
      await supabase
        .from("transaction_participants")
        .delete()
        .eq("transaction_id", gp.transaction_id)
        .eq("person_id", ghostId);
    } else {
      // Nur Ghost war Teilnehmer → einfach umhängen
      await supabase
        .from("transaction_participants")
        .update({ person_id: realId })
        .eq("transaction_id", gp.transaction_id)
        .eq("person_id", ghostId);
    }
  }

  // 3. Anzahlungs-Obligation: PK (trip_id, person_id). Wenn beide eine
  //    haben, behalten wir die real-Zeile.
  const [{ data: ghostObl }, { data: realObl }] = await Promise.all([
    supabase.from("prepayment_obligations").select("cabin_type_id, total_amount").eq("trip_id", tripId).eq("person_id", ghostId).maybeSingle(),
    supabase.from("prepayment_obligations").select("person_id").eq("trip_id", tripId).eq("person_id", realId).maybeSingle(),
  ]);
  if (ghostObl) {
    if (!realObl) {
      await supabase.from("prepayment_obligations").insert({
        trip_id: tripId,
        person_id: realId,
        cabin_type_id: ghostObl.cabin_type_id,
        total_amount: ghostObl.total_amount,
      });
    }
    await supabase.from("prepayment_obligations").delete().eq("trip_id", tripId).eq("person_id", ghostId);
  }

  // 4. trip_members: Ghost-Eintrag auf real umhängen. Der Pre-Check oben
  //    hat sichergestellt, dass real noch nicht Mitglied dieses Trips ist —
  //    UNIQUE (trip_id, person_id) ist daher safe.
  await supabase
    .from("trip_members")
    .update({ person_id: realId })
    .eq("trip_id", tripId)
    .eq("person_id", ghostId);

  // 5. Trip-Skipper-FK darf nicht auf den Ghost zeigen (RESTRICT beim Delete)
  await supabase.from("trips").update({ skipper_id: realId }).eq("skipper_id", ghostId);

  // 6. Audit-Log-Spalte actor_person_id, falls Ghost je Actor war
  await supabase.from("audit_log").update({ actor_person_id: realId }).eq("actor_person_id", ghostId);

  // 7. settled_debts: from_person_id / to_person_id (Schulden-Häkchen)
  await supabase.from("settled_debts").update({ from_person_id: realId }).eq("from_person_id", ghostId);
  await supabase.from("settled_debts").update({ to_person_id: realId }).eq("to_person_id", ghostId);

  // 8. Ghost-Person + persons_private löschen
  await supabase.from("persons_private").delete().eq("person_id", ghostId);
  const { error: delErr } = await supabase.from("persons").delete().eq("id", ghostId);
  if (delErr) {
    return {
      ok: false,
      message: `Ghost-Person konnte nicht gelöscht werden (vermutlich noch unbekannter Foreign-Key-Verweis): ${delErr.message}`,
    };
  }

  await logAudit(supabase, {
    table_name: "persons",
    operation: "DELETE",
    record_id: ghostId,
    trip_id: tripId,
    actor_person_id: actorPersonId,
    payload: {
      kind: "ghost-merge",
      merged_into: realId,
      txn_refs_moved: ghostParticipations?.length ?? 0,
    },
  });

  return { ok: true };
}

