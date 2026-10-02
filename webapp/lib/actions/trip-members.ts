"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSkipperOrAdmin } from "@/lib/auth/authz";
import { logAudit } from "@/lib/db/audit";
import { sendInvitationMagicLink } from "@/lib/auth/invite";
import { resolveOrigin } from "@/lib/auth/origin";
import { daysBetween, displayNameFromEmail } from "@/lib/utils";
import { calculateItemObligations } from "@/lib/calc/prepayment-item-shares";
import { personHasBookingTrace } from "@/lib/auth/cross-trip";
import { assertTripNotArchived } from "@/lib/auth/trip-state";

const InviteSchema = z.object({
  trip_id: z.string().uuid(),
  // E-Mail ist optional, damit der Skipper Crew anlegen kann, ohne sie zu kennen.
  // Ohne E-Mail kann sich die Person nicht einloggen, taucht aber in der App
  // als „Ghost"-Person auf — Soll-Zuordnung, Buchungsbeteiligung und
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
  | { status: "ok"; warning?: string }
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

  const archivedCheck = await assertTripNotArchived(supabase, trip_id);
  if (!archivedCheck.ok) return { status: "error", message: archivedCheck.message };

  // Person mit dieser E-Mail finden (über persons_private) oder als Ghost
  // anlegen. E-Mail liegt seit Migration 0013 ausschließlich in
  // persons_private — persons selbst hat sie nicht mehr.
  // Sonderfall ohne E-Mail: direkt neue Ghost-Person (kein persons_private-Eintrag).
  // Fund 9 (Code-Review 2026-08): `.eq` statt `.ilike` (CITEXT ist bereits
  // case-insensitiv) + Fehler geprüft, statt ihn still als "nicht gefunden"
  // durchzureichen (sonst legt der else-Zweig eine Person an, deren
  // persons_private-Insert danach an der UNIQUE-Constraint scheitert, statt
  // einer klaren Fehlermeldung an dieser Stelle).
  let personId: string;
  if (email) {
    const { data: existingPriv, error: lookupErr } = await supabase
      .from("persons_private")
      .select("person_id")
      .eq("email", email)
      .maybeSingle();
    if (lookupErr) {
      console.error("[bordkasse:db]", lookupErr.message);
      return { status: "error", message: "E-Mail-Suche fehlgeschlagen. Bitte erneut versuchen." };
    }

    if (existingPriv) {
      personId = existingPriv.person_id;
    } else {
      const fallbackName = display_name || displayNameFromEmail(email);
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
    // Grill-Review-Fund (PR 7, Fund 4): `note` ist ein Freitextfeld und kann
    // personenbezogene Hinweise enthalten — nicht ins Audit-Log spiegeln.
    const { note: _memberNote, ...memberAuditPayload } = member;
    await logAudit(supabase, {
      table_name: "trip_members",
      operation: "INSERT",
      record_id: member.id,
      trip_id,
      actor_person_id: auth.personId,
      payload: memberAuditPayload,
    });
  }

  // Einladungs-Mail nur bei NEUER Mitgliedschaft UND vorhandener E-Mail.
  // Der Versand darf das Anlegen NICHT abbrechen — das Mitglied ist oben
  // bereits gespeichert. Ein Fehler (z. B. fehlende Origin-Env oder SMTP-
  // Problem) wird daher als weiche Warnung zurückgegeben statt als Exception
  // (die früher die Error-Boundary auslöste und so wirkte, als sei nichts
  // passiert — obwohl das Mitglied längst angelegt war).
  let warning: string | undefined;
  if (!wasAlreadyMember && email) {
    try {
      const hdrs = await headers();
      const origin = resolveOrigin(hdrs.get("origin"));
      const res = await sendInvitationMagicLink(email, origin);
      if (!res.ok) {
        warning = "Mitglied hinzugefügt, aber die Einladungs-Mail konnte nicht verschickt werden.";
        console.error("[bordkasse:invite] Versand fehlgeschlagen:", res.message);
      }
    } catch (e) {
      warning = "Mitglied hinzugefügt, aber die Einladungs-Mail konnte nicht verschickt werden.";
      console.error("[bordkasse:invite]", e);
    }
  }

  revalidatePath(`/trips/${trip_id}/settings`);
  revalidatePath(`/trips/${trip_id}`);
  return warning ? { status: "ok", warning } : { status: "ok" };
}

export async function removeMember(
  memberId: string,
  tripId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const auth = await requireSkipperOrAdmin(tripId);
  if (!auth.ok) return { ok: false, message: auth.message };
  const supabase = createAdminClient();

  const archivedCheck = await assertTripNotArchived(supabase, tripId);
  if (!archivedCheck.ok) return { ok: false, message: archivedCheck.message };

  // IDOR-Schutz (Fund 4, Code-Review 2026-08): memberId wird OHNE trip_id-
  // Filter gelesen/gelöscht — ein Skipper von Törn A könnte sonst eine
  // fremde trip_members.id aus Törn B übergeben (per RLS für jedes Mitglied
  // von B lesbar) und deren Mitgliedschaft löschen, während der Buchungs-
  // und Owner-Schutz unten immer gegen Törn A prüfen und den fremden Törn
  // damit nie schützen. .eq("trip_id", tripId) macht memberId + tripId zu
  // einem zusammengehörigen Schlüssel.
  const [{ data: tripRow }, { data: memberRow }] = await Promise.all([
    supabase.from("trips").select("skipper_id").eq("id", tripId).maybeSingle(),
    supabase.from("trip_members").select("person_id").eq("id", memberId).eq("trip_id", tripId).maybeSingle(),
  ]);
  if (!memberRow) return { ok: false, message: "Crewmitglied nicht gefunden." };

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
  //
  // Fund 6 (Code-Review 2026-08): geprüft wurden bisher nur paid_by/
  // credit_from/credit_to — eine Person, die NUR über transaction_
  // participants an einer Buchung beteiligt ist (split_type='individual'
  // oder 'per_person'), ließ sich trotzdem entfernen. Bei 'per_person'
  // bleibt der Anteil dann als unallokierter Rest in v_transaction_shares
  // stehen (Σ balance ≠ 0), ohne jede Fehlermeldung — analog zum Blocker in
  // delete_my_account() (Migration 0021), der genau das schon verhindert.
  const personId = memberRow.person_id;

  // PR4a (Reise-Posten, 0058): Empfänger und offenes Posten-Soll.
  //   • Empfänger → blocken (die Empfänger-Rolle zählt zusätzlich in
  //     personHasBookingTrace als Spur): die Crew zahlt ihr Geld an diese
  //     Person (credit_to); ohne Mitgliedschaft fielen diese Gutschriften aus
  //     v_balances (Σ ≠ 0).
  //   • Offenes Soll (Entscheidung M3, PR4a-Review): ein stilles Löschen
  //     ließe Σ Soll < Posten-Summe zurück. Ist der Posten gleichmäßig/
  //     zeitanteilig verteilt, gibt es noch keine Anbieter-Zahlung und hat
  //     diese Person für den Posten noch nichts gezahlt/gemeldet, verteilt
  //     removeMember das Soll auf die verbleibende Crew neu (Σ = Summe
  //     exakt). Sonst wird geblockt — ein Neuspeichern des Postens verteilt
  //     seit M2 NICHT mehr automatisch neu, der Hinweis nennt deshalb den
  //     konkreten Weg.
  // Alles hier ist nur Lesen/Planen; geschrieben wird erst unten nach allen
  // Prüfungen. Fail-closed bei Lesefehlern.
  type ItemRedistribution = {
    itemId: string;
    rows: { person_id: string; amount: number }[];
    oldRows: { person_id: string; amount: number }[];
  };
  const itemRedistributions: ItemRedistribution[] = [];
  {
    const [payeeRes, itemOblRes] = await Promise.all([
      supabase
        .from("prepayment_items")
        .select("id", { count: "exact", head: true })
        .eq("trip_id", tripId)
        .eq("payee_person_id", personId),
      supabase
        .from("prepayment_item_obligations")
        .select("item_id, amount")
        .eq("trip_id", tripId)
        .eq("person_id", personId),
    ]);
    if (payeeRes.error || itemOblRes.error) {
      console.error("[bordkasse:db] removeMember item check:", payeeRes.error?.message ?? itemOblRes.error?.message);
      return { ok: false, message: "Posten konnten nicht geprüft werden. Bitte erneut versuchen." };
    }
    if ((payeeRes.count ?? 0) > 0) {
      return {
        ok: false,
        message:
          "Diese Person empfängt die Zahlungen für einen Posten (z. B. An-/Abreise). Bitte zuerst im Posten eine andere Person als Empfänger eintragen.",
      };
    }
    const openItemIds = (itemOblRes.data ?? []).filter((o) => Number(o.amount) > 0).map((o) => o.item_id as string);
    if (openItemIds.length > 0) {
      const plan = await planItemRedistribution(supabase, tripId, personId, openItemIds);
      if (!plan.ok) return { ok: false, message: plan.message };
      itemRedistributions.push(...plan.redistributions);
    }
  }

  // Geteilter Helfer mit replaceMember (lib/actions/prepayments.ts, PR 4) —
  // lib/auth/cross-trip.ts:personHasBookingTrace, DRY statt zweier
  // driftender Kopien.
  if (await personHasBookingTrace(supabase, tripId, personId)) {
    return {
      ok: false,
      message:
        "Diese Person hat noch Buchungen in diesem Törn. Bitte erst die Buchungen umbuchen (paid_by ändern) oder löschen, bevor du sie entfernst.",
    };
  }

  // Fund E (Sanierungsplan PR 9b): personHasBookingTrace prüft nur
  // transactions/transaction_participants — eine Person, die aus dem Törn
  // entfernt wird, kann trotzdem noch ein offenes Anzahlungs-Soll in
  // prepayment_obligations(trip_id, person_id) stehen haben (z. B. ein Törn
  // mit Anzahlungsplan, in dem diese Person nie selbst gebucht hat).
  //
  // ⚠️ Grill-Review-Fund: ein stilles Löschen dieser Zeile lässt
  // Σ obligations.total_amount < prepayment_plan.total_amount zurück, ohne
  // dass irgendetwas das neu verteilt oder den Vorstrecker warnt — bei
  // gleichmaessig/zeitanteilig sammelt er dauerhaft weniger ein, als die
  // Charter kostet, ohne sichtbares Signal (die Matrix zeigt nur noch aktive
  // Crew, keinen Fehlbetrag). Deshalb: BLOCKEN statt still löschen, solange
  // ein offenes (>0) Soll besteht — der Skipper muss den Anzahlungsplan im
  // Wizard neu speichern (verteilt bei gleichmaessig/zeitanteilig automatisch
  // neu, siehe savePrepaymentPlan/calculateObligations) oder das Soll bei
  // individuell/kojen bewusst auf 0 setzen, BEVOR die Person entfernt wird.
  const { data: obligationRow } = await supabase
    .from("prepayment_obligations")
    .select("total_amount")
    .eq("trip_id", tripId)
    .eq("person_id", personId)
    .maybeSingle();
  if (obligationRow && Number(obligationRow.total_amount) > 0) {
    return {
      ok: false,
      message:
        "Diese Person hat noch ein offenes Anzahlungs-Soll. Bitte zuerst den Anzahlungsplan anpassen (Einstellungen → Anzahlungsplan), bevor du sie entfernst.",
    };
  }

  // PR4a (M3, Delta-Review 1/5): Posten-Soll neu verteilen. Pro Posten ERST
  // die neuen Beträge der Rest-Crew per Upsert schreiben, DANN nur die Zeile
  // der entfernten Person löschen — so gibt es nie einen Augenblick mit 0
  // Sollzeilen. Jeder Fehler (auch die Nachkontrolle und das Entfernen der
  // Mitgliedschaft) schreibt die alten Zeilen zurück.
  const redistributed: ItemRedistribution[] = [];
  const restoreRedistributions = async (): Promise<boolean> => {
    let ok = true;
    for (const r of redistributed) {
      const { error } = await supabase.from("prepayment_item_obligations").upsert(
        r.oldRows.map((row) => ({ item_id: r.itemId, trip_id: tripId, person_id: row.person_id, amount: row.amount })),
        { onConflict: "item_id,person_id" },
      );
      if (error) {
        ok = false;
        console.error("[bordkasse:db] removeMember restore:", error.message);
      }
    }
    return ok;
  };
  const failRestoring = async (message: string): Promise<{ ok: false; message: string }> => {
    const restored = await restoreRedistributions();
    return {
      ok: false,
      message: restored ? message : `${message} Achtung: das Zurücksetzen ist ebenfalls fehlgeschlagen — bitte den Posten prüfen.`,
    };
  };
  for (const r of itemRedistributions) {
    const { error: upErr } = await supabase.from("prepayment_item_obligations").upsert(
      r.rows.map((row) => ({ item_id: r.itemId, trip_id: tripId, person_id: row.person_id, amount: row.amount })),
      { onConflict: "item_id,person_id" },
    );
    redistributed.push(r);
    if (upErr) {
      console.error("[bordkasse:db] removeMember item redistribution/upsert:", upErr.message);
      return failRestoring("Posten-Soll konnte nicht neu verteilt werden. Bitte erneut versuchen.");
    }
    const { error: delErr } = await supabase
      .from("prepayment_item_obligations")
      .delete()
      .eq("trip_id", tripId)
      .eq("item_id", r.itemId)
      .eq("person_id", personId);
    if (delErr) {
      console.error("[bordkasse:db] removeMember item redistribution/delete:", delErr.message);
      return failRestoring("Posten-Soll konnte nicht neu verteilt werden. Bitte erneut versuchen.");
    }
  }
  if (redistributed.length > 0) {
    // Nachkontrolle (wie saveItem): ist inzwischen eine Anbieter-Zahlung
    // gebucht worden, wurde sie nach dem ALTEN Soll verteilt → zurückrollen.
    const { count, error } = await supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("trip_id", tripId)
      .eq("type", "expense")
      .in("item_id", redistributed.map((r) => r.itemId))
      .is("deleted_at", null);
    if (error) return failRestoring("Posten konnten nicht geprüft werden. Bitte erneut versuchen.");
    if ((count ?? 0) > 0) {
      return failRestoring(
        "Während des Entfernens wurde eine Zahlung an den Anbieter gebucht. Bitte Seite neu laden und erneut versuchen.",
      );
    }
  }
  {
    // Übrige (0-€-)Sollzeilen der Person — fail-loud (Review P3), sonst
    // bliebe ein Soll für eine Person ohne Mitgliedschaft.
    const { error } = await supabase
      .from("prepayment_item_obligations")
      .delete()
      .eq("trip_id", tripId)
      .eq("person_id", personId);
    if (error) {
      console.error("[bordkasse:db] removeMember item obligations cleanup:", error.message);
      return failRestoring("Posten-Soll konnte nicht aufgeräumt werden. Bitte erneut versuchen.");
    }
  }

  {
    const { error: memberDelErr } = await supabase.from("trip_members").delete().eq("id", memberId).eq("trip_id", tripId);
    if (memberDelErr) {
      console.error("[bordkasse:db] removeMember trip_members delete:", memberDelErr.message);
      return failRestoring("Crewmitglied konnte nicht entfernt werden. Bitte erneut versuchen.");
    }
  }
  if (redistributed.length > 0) {
    await logAudit(supabase, {
      table_name: "prepayment_item_obligations",
      operation: "UPDATE",
      record_id: memberId,
      trip_id: tripId,
      actor_person_id: auth.personId,
      payload: { kind: "item-soll-redistributed", item_ids: redistributed.map((r) => r.itemId) },
    });
  }

  // Posten-Erinnerungen (PR5, Migration 0061), best effort:
  //   • umverteilte Posten → Log zurücksetzen (die Rest-Crew schuldet jetzt
  //     MEHR; wer schon erinnert wurde oder bezahlt hatte, ist wieder offen),
  //   • Zeilen der entfernten Person löschen (tote Dedup-Zeilen würden eine
  //     fällige Erinnerung unterdrücken, falls sie später wieder beitritt).
  if (redistributed.length > 0) {
    const { error } = await supabase
      .from("prepayment_item_reminder_log")
      .delete()
      .eq("trip_id", tripId)
      .in("item_id", redistributed.map((r) => r.itemId));
    if (error) console.error("[bordkasse:db] removeMember item reminder_log reset:", error.message);
  }
  {
    const { error } = await supabase
      .from("prepayment_item_reminder_log")
      .delete()
      .eq("trip_id", tripId)
      .eq("person_id", personId);
    if (error) console.error("[bordkasse:db] removeMember item reminder_log cleanup:", error.message);
  }


  // Kein offenes Soll (0 oder keine Zeile) → die Obligation-Zeile selbst
  // (falls vorhanden, mit total_amount = 0) kann gefahrlos mitgelöscht
  // werden — sie hätte ohnehin nichts mehr beigetragen.
  await supabase.from("prepayment_obligations").delete().eq("trip_id", tripId).eq("person_id", personId);

  // settled_debts referenziert die Person direkt (from_person_id/
  // to_person_id, kein FK auf trip_members) — ein Fantom-Häkchen für eine
  // nicht mehr existierende Crew-Person wäre verwirrend, auch wenn es wegen
  // fehlender Buchungsspur (Bilanzbeitrag = 0) praktisch nie neu entsteht.
  // Defensiv trotzdem aufräumen, statt auf diese Invariante zu vertrauen.
  await supabase
    .from("settled_debts")
    .delete()
    .eq("trip_id", tripId)
    .or(`from_person_id.eq.${personId},to_person_id.eq.${personId}`);

  await logAudit(supabase, {
    table_name: "trip_members",
    operation: "DELETE",
    record_id: memberId,
    trip_id: tripId,
    actor_person_id: auth.personId,
  });
  revalidatePath(`/trips/${tripId}/settings`);
  revalidatePath(`/trips/${tripId}`);
  revalidatePath(`/trips/${tripId}/prepayments`);
  revalidatePath(`/trips/${tripId}/balance`);
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
 * Update einer Crewperson:
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

  const archivedCheck = await assertTripNotArchived(supabase, trip_id);
  if (!archivedCheck.ok) return { status: "error", message: archivedCheck.message };

  // Member + zugehörige Person holen — wir brauchen person_id + Ghost-Status.
  const { data: member } = await supabase
    .from("trip_members")
    .select("person_id, persons!inner(auth_user_id)")
    .eq("id", member_id)
    .eq("trip_id", trip_id)
    .maybeSingle();
  if (!member) return { status: "error", message: "Crewmitglied nicht gefunden." };

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
        // Kein Klartext-Name im Audit-Log (DSGVO) — nur die Tatsache der
        // Änderung, keine personenbezogenen Werte.
        payload: { name_changed: true },
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
      // bestehenden Account integriert.
      //
      // Fund 9 (Code-Review 2026-08): `.eq` statt `.ilike` — die Spalte ist
      // bereits CITEXT (case-insensitiv), `ilike` brachte nur unbeabsichtigte
      // Wildcards ins Spiel. Mit `_` als Ein-Zeichen-Joker hätte eine
      // nachgetragene E-Mail wie `max_mueller@…` sonst fälschlich mit dem
      // ANDEREN Ghost-Eintrag `max.mueller@…` „matchen" und einen
      // unbeabsichtigten Merge auslösen können. Fehler wird jetzt geprüft,
      // statt still als "keine Kollision" durchzureichen.
      const { data: emailInUse, error: emailInUseErr } = await supabase
        .from("persons_private")
        .select("person_id, persons!inner(display_name, auth_user_id)")
        .eq("email", email)
        .neq("person_id", member.person_id)
        .maybeSingle();
      if (emailInUseErr) {
        console.error("[bordkasse:db]", emailInUseErr.message);
        return { status: "error", message: "E-Mail-Prüfung fehlgeschlagen. Bitte erneut versuchen." };
      }

      if (emailInUse) {
        // Consent-Schutz: Gehört die E-Mail einem bereits REGISTRIERTEN
        // Account (auth_user_id gesetzt), dürfen wir diese fremde Identität
        // NICHT still in den Törn ziehen — das wäre Einladung-per-Raten
        // statt Einladung-per-Einwilligung. Auto-Merge bleibt nur für echte
        // Ghosts ohne Login (zwei vom Skipper angelegte Platzhalter).
        // Der Skipper soll die Person stattdessen über „Crew einladen" mit
        // dieser E-Mail hinzufügen — dann behält sie ihr bestehendes Konto
        // und bekommt einen Login-Link, den sie selbst annehmen kann.
        const inUsePerson = (emailInUse as unknown as {
          persons: { display_name: string; auth_user_id: string | null }
            | { display_name: string; auth_user_id: string | null }[];
        }).persons;
        const inUse = Array.isArray(inUsePerson) ? inUsePerson[0] : inUsePerson;
        if (inUse?.auth_user_id) {
          // Fund 2 (Sanierungsplan PR 3): kein Anzeigename der fremden Person
          // in der Fehlermeldung — sonst könnte ein Skipper allein durch
          // Raten einer E-Mail-Adresse erfahren, wem sie gehört.
          return {
            status: "error",
            message:
              "Diese E-Mail-Adresse gehört bereits zu einem bestehenden Konto. " +
              "Entferne den aktuellen Creweintrag (ohne E-Mail) und füge die Person " +
              "stattdessen über „Crew einladen“ mit dieser E-Mail hinzu — sie behält dann ihr " +
              "bestehendes Konto und bekommt einen Login-Link.",
          };
        }

        // Fund 1/5/6 (Sanierungsplan PR 3): ist die per E-Mail gefundene
        // Zielperson (ein Ghost ohne Login) auch Crew eines ANDEREN Törns,
        // ist sie ein GETEILTER Ghost. Ein Skipper darf deren Identität
        // (Name/E-Mail) dann nicht unilateral umbiegen — das würde die
        // Person auch für den fremden Törn verändern, dessen Skipper hier
        // gar nicht gefragt wird. Auto-Merge bleibt nur erlaubt, wenn die
        // Zielperson (noch) ausschließlich Crew dieses einen Törns ist.
        const { count: targetOtherTripCount, error: targetOtherTripErr } = await supabase
          .from("trip_members")
          .select("*", { count: "exact", head: true })
          .eq("person_id", emailInUse.person_id)
          .neq("trip_id", trip_id);
        if (targetOtherTripErr) {
          console.error("[bordkasse:db]", targetOtherTripErr.message);
          return { status: "error", message: "Prüfung auf geteilte Crew fehlgeschlagen. Bitte erneut versuchen." };
        }
        if ((targetOtherTripCount ?? 0) > 0) {
          return {
            status: "error",
            message:
              "Diese E-Mail-Adresse gehört zu einer Person, die auch Crew eines anderen Törns ist. " +
              "Eine automatische Verschmelzung ist deshalb gesperrt — bitte manuell prüfen oder einen Admin einbeziehen.",
          };
        }

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
        // Kein Klartext-E-Mail im Audit-Log (DSGVO) — nur die Tatsache der
        // Änderung, keine personenbezogenen Werte.
        payload: { email_changed: true },
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

  const archivedCheck = await assertTripNotArchived(supabase, tripId);
  if (!archivedCheck.ok) return;

  // IDOR-Schutz (Fund 4, Code-Review 2026-08): memberId OHNE trip_id-Filter
  // zu lesen/schreiben ließe einen Skipper von Törn A eine fremde
  // trip_members.id aus Törn B übergeben (per RLS für jedes Mitglied von B
  // lesbar) und dort is_skipper setzen — Selbst-Beförderung zum Co-Skipper
  // eines fremden Törns. .eq("trip_id", tripId) bindet memberId an DIESEN
  // Törn.
  const [{ data: tripRow }, { data: memberRow }] = await Promise.all([
    supabase.from("trips").select("skipper_id").eq("id", tripId).maybeSingle(),
    supabase.from("trip_members").select("person_id").eq("id", memberId).eq("trip_id", tripId).maybeSingle(),
  ]);
  if (!tripRow || !memberRow) return;
  // Original-Owner kann nicht von der Skipper-Rolle entbunden werden.
  if (!isSkipper && tripRow.skipper_id === memberRow.person_id) return;

  await supabase.from("trip_members").update({ is_skipper: isSkipper }).eq("id", memberId).eq("trip_id", tripId);
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
 * automatisch: ALLE Verweise (Buchungen, Anzahlungssoll, Trip-Membership,
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
 *
 * WICHTIGE VORAUSSETZUNG (Fund 5, Code-Review 2026-08): der Ghost darf
 * NIRGENDS außer in `tripId` Crew sein. Schritt 1/6 hängen transactions/
 * audit_log GLOBAL um (kein trip_id-Filter) — ohne diese Voraussetzung
 * würden Buchungen eines FREMDEN Törns auf `realId` umgehängt, obwohl real
 * dort gar nicht Mitglied ist (Phantom-Gläubiger in
 * v_balances_bordkasse_only, all_debts_settled nie erfüllbar → der fremde
 * Törn wird dauerhaft unpurgebar). Ein eigener Pre-Check lehnt den Merge
 * deshalb ab, wenn der Ghost Mitglied eines anderen Törns ist — dieser Fall
 * ist selten (nur möglich, wenn zwei Skipper denselben Ghost per E-Mail in
 * unterschiedliche Törns eingeladen haben) und braucht eine bewusste,
 * manuelle Entscheidung statt einer automatischen Verschmelzung.
 */
async function mergeGhostIntoExistingPerson(
  supabase: ReturnType<typeof createAdminClient>,
  ghostId: string,
  realId: string,
  tripId: string,
  actorPersonId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  // Pre-Check: ist die echte Person bereits Crewmitglied DIESES Trips?
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
        `„${realName}" ist mit dieser E-Mail-Adresse bereits Crewmitglied dieses Törns. ` +
        `Lösche entweder den aktuellen Creweintrag (ohne E-Mail) oder den bestehenden „${realName}"-Eintrag, ` +
        `damit die Person nur einmal vorkommt.`,
    };
  }

  // Pre-Check (Fund 5, Code-Review 2026-08): ist der Ghost Mitglied eines
  // ANDEREN Törns? Die folgenden Schritte hängen transactions/audit_log
  // GLOBAL um (ohne trip_id-Filter) — das ist nur sicher, wenn der Ghost
  // NIRGENDS außer in diesem Törn Crew war. Ohne diesen Check würden
  // Buchungen eines fremden Törns auf `realId` umgehängt, obwohl real dort
  // gar nicht Mitglied ist (Bilanz-Bruch in v_balances/
  // v_balances_bordkasse_only — Phantom-Gläubiger, simplify_debts plant
  // Überweisungen an eine törnfremde Person, all_debts_settled wird nie
  // wahr → der fremde Törn wird dauerhaft unpurgebar). Zusätzlich schlägt
  // der abschließende persons-DELETE dort an der NO-ACTION-FK von
  // trip_members.person_id fehl, aber ERST NACHDEM die globalen UPDATEs
  // (Schritt 1/6) bereits gelaufen sind — der Skipper sieht einen Fehler,
  // während der fremde Törn schon beschädigt ist.
  const { count: foreignMembershipCount } = await supabase
    .from("trip_members")
    .select("*", { count: "exact", head: true })
    .eq("person_id", ghostId)
    .neq("trip_id", tripId);
  if ((foreignMembershipCount ?? 0) > 0) {
    return {
      ok: false,
      message:
        "Diese Person ist Crewmitglied in mindestens einem anderen Törn. Eine automatische " +
        "Verschmelzung würde dort Buchungen fälschlich umhängen und ist daher gesperrt. Falls die " +
        "beiden Einträge trotzdem dieselbe Person sind, lass den aktuellen Ghost-Eintrag (ohne E-Mail) " +
        "stehen und trage die E-Mail stattdessen direkt am bestehenden Konto ein — oder wende dich bei " +
        "Bedarf an einen Admin.",
    };
  }

  // Pre-Check (PR4a, Reise-Posten 0058): ist der Ghost Empfänger eines
  // Postens? Dann muss der Empfänger mitwandern — sonst scheiterte das finale
  // persons-DELETE an `payee_person_id ON DELETE RESTRICT`, und ein
  // credit_to-Update der Posten-Gutschriften bräche am Trigger
  // tx_item_credit_payee ab. Der Wechsel läuft atomar über move_item_payee
  // (Migration 0059, Schritt 4b). Hier nur LESEN — Lesefehler brechen ab,
  // BEVOR irgendetwas geschrieben wurde.
  // Global (ohne trip_id-Filter, Review P3): ist der Ghost Empfänger eines
  // Postens in einem ANDEREN Törn, würde das finale persons-DELETE an
  // RESTRICT scheitern — erst nach allen Writes. Deshalb vorab blocken.
  const { data: ghostPayeeAll, error: ghostPayeeErr } = await supabase
    .from("prepayment_items")
    .select("id, trip_id")
    .eq("payee_person_id", ghostId);
  if (ghostPayeeErr) {
    console.error("[bordkasse:db] mergeGhostIntoExistingPerson payee check:", ghostPayeeErr.message);
    return { ok: false, message: "Posten konnten nicht geprüft werden. Bitte erneut versuchen." };
  }
  if ((ghostPayeeAll ?? []).some((it) => it.trip_id !== tripId)) {
    return {
      ok: false,
      message:
        "Diese Person empfängt Zahlungen für einen Posten in einem anderen Törn. Eine automatische Verschmelzung ist " +
        "deshalb gesperrt — bitte einen Admin einbeziehen.",
    };
  }
  const ghostPayeeItems = ghostPayeeAll ?? [];
  // Probe (Review P1): move_item_payee als No-op (gleicher Empfänger → 0)
  // VOR jedem Schreibschritt aufrufen. Beweist, dass die Funktion mit der
  // 3-Argument-Signatur aus 0060 existiert und im PostgREST-Schemacache ist
  // (ohne 0060 findet PostgREST die Signatur mit `p_move_credits` nicht).
  // Sie beweist NICHT, dass der spätere echte Wechsel gelingt (z. B. kann
  // dort noch eine fremde Anbieter-Zahlung blocken).
  // Sonst schlüge Schritt 4b erst NACH dem Umhängen der Mitgliedschaft fehl
  // — Gutschriften an einen Ghost ohne Mitgliedschaft.
  for (const it of ghostPayeeItems) {
    const { error } = await supabase.rpc("move_item_payee", { p_item_id: it.id, p_new_payee: ghostId, p_move_credits: true });
    if (error) {
      console.error("[bordkasse:db] mergeGhostIntoExistingPerson move_item_payee probe:", error.message);
      return {
        ok: false,
        message: "Die Verschmelzung ist gerade nicht möglich (Datenbank-Funktion fehlt). Bitte einen Admin kontaktieren.",
      };
    }
  }
  // Posten-Soll des Ghosts (person_id → persons ON DELETE CASCADE): würde
  // beim finalen persons-DELETE sonst STILL verschwinden.
  const { data: ghostItemObl, error: ghostItemOblErr } = await supabase
    .from("prepayment_item_obligations")
    .select("item_id, amount")
    .eq("trip_id", tripId)
    .eq("person_id", ghostId);
  if (ghostItemOblErr) {
    console.error("[bordkasse:db] mergeGhostIntoExistingPerson item obligations:", ghostItemOblErr.message);
    return { ok: false, message: "Posten-Soll konnte nicht geprüft werden. Bitte erneut versuchen." };
  }

  // Generischer Fehler-Text für alle Zwischenschritte unten — Fund 3
  // (Sanierungsplan PR 9a): jeder Schritt verwarf bisher den Rückgabewert,
  // ein Fehler mittendrin blieb unbemerkt und die Funktion log am Ende
  // trotzdem {ok:true}, obwohl ein teil-gemergter Zustand zurückblieb (keine
  // echte DB-Transaktion über den Service-Role-Client möglich — siehe
  // gleiches Limit in lib/actions/prepayments.ts:replaceMember). Ziel hier
  // ist NUR, den Fehler sichtbar zu machen, kein Rollback.
  const mergeStepFailed = (step: string, message: string): { ok: false; message: string } => {
    console.error(`[bordkasse:db] mergeGhostIntoExistingPerson step "${step}" failed:`, message);
    return {
      ok: false,
      message: `Verschmelzung mittendrin fehlgeschlagen (Schritt „${step}"). Daten können jetzt teilweise ` +
        `verschmolzen sein — bitte einen Admin kontaktieren, statt es erneut zu versuchen: ${message}`,
    };
  };

  // 1. transactions: paid_by / credit_from / credit_to umhängen — keine
  //    Constraints betroffen, einfache UPDATEs. Durch den Pre-Check oben
  //    ist der Ghost NUR in diesem Törn Crew, ein globales UPDATE ist damit
  //    ungefährlich (der Ghost kann in keinem anderen Törn referenziert sein).
  {
    const { error } = await supabase.from("transactions").update({ paid_by: realId }).eq("paid_by", ghostId);
    if (error) return mergeStepFailed("transactions.paid_by", error.message);
  }
  {
    const { error } = await supabase.from("transactions").update({ credit_from: realId }).eq("credit_from", ghostId);
    if (error) return mergeStepFailed("transactions.credit_from", error.message);
  }
  {
    // PR4a: Posten-Gutschriften (item_id) NICHT hier — ihr credit_to muss dem
    // Posten-Empfänger entsprechen (Trigger tx_item_credit_payee), solange der
    // noch der Ghost ist, würde das Update abgewiesen. move_item_payee hängt
    // sie in Schritt 4b zusammen mit dem Empfänger um.
    const { error } = await supabase
      .from("transactions")
      .update({ credit_to: realId })
      .eq("credit_to", ghostId)
      .is("item_id", null);
    if (error) return mergeStepFailed("transactions.credit_to", error.message);
  }
  {
    const { error } = await supabase.from("transactions").update({ created_by: realId }).eq("created_by", ghostId);
    if (error) return mergeStepFailed("transactions.created_by", error.message);
  }

  // 2. transaction_participants: PK (transaction_id, person_id). Wenn
  //    Ghost+real beide auf der gleichen Buchung waren, behalten wir die
  //    real-Zeile und addieren ggf. den per_person-Betrag des Ghosts dazu.
  const { data: ghostParticipations, error: ghostPartErr } = await supabase
    .from("transaction_participants")
    .select("transaction_id, amount")
    .eq("person_id", ghostId);
  if (ghostPartErr) return mergeStepFailed("transaction_participants.select", ghostPartErr.message);
  for (const gp of ghostParticipations ?? []) {
    const { data: realPart, error: realPartErr } = await supabase
      .from("transaction_participants")
      .select("amount")
      .eq("transaction_id", gp.transaction_id)
      .eq("person_id", realId)
      .maybeSingle();
    if (realPartErr) return mergeStepFailed("transaction_participants.select_real", realPartErr.message);
    if (realPart) {
      // Doppelte Teilnahme — Ghost-Eintrag verwerfen.
      // Bei per_person addieren wir den Ghost-Betrag aufs real-Konto (sonst
      // würde Σ(participant.amount) plötzlich kleiner als transaction.amount).
      if (gp.amount != null && realPart.amount != null) {
        const { error } = await supabase
          .from("transaction_participants")
          .update({ amount: Number(realPart.amount) + Number(gp.amount) })
          .eq("transaction_id", gp.transaction_id)
          .eq("person_id", realId);
        if (error) return mergeStepFailed("transaction_participants.merge_amount", error.message);
      } else if (gp.amount != null && realPart.amount == null) {
        // real war individual-Teilnehmer ohne Betrag, Ghost war per_person mit Betrag — behalte den Betrag
        const { error } = await supabase
          .from("transaction_participants")
          .update({ amount: gp.amount })
          .eq("transaction_id", gp.transaction_id)
          .eq("person_id", realId);
        if (error) return mergeStepFailed("transaction_participants.take_amount", error.message);
      }
      const { error } = await supabase
        .from("transaction_participants")
        .delete()
        .eq("transaction_id", gp.transaction_id)
        .eq("person_id", ghostId);
      if (error) return mergeStepFailed("transaction_participants.delete_ghost", error.message);
    } else {
      // Nur Ghost war Teilnehmer → einfach umhängen
      const { error } = await supabase
        .from("transaction_participants")
        .update({ person_id: realId })
        .eq("transaction_id", gp.transaction_id)
        .eq("person_id", ghostId);
      if (error) return mergeStepFailed("transaction_participants.reassign", error.message);
    }
  }

  // 3. Anzahlungs-Obligation: PK (trip_id, person_id). Wenn beide eine
  //    haben, behalten wir die real-Zeile.
  const [{ data: ghostObl, error: ghostOblErr }, { data: realObl, error: realOblErr }] = await Promise.all([
    supabase.from("prepayment_obligations").select("cabin_type_id, total_amount").eq("trip_id", tripId).eq("person_id", ghostId).maybeSingle(),
    supabase.from("prepayment_obligations").select("person_id").eq("trip_id", tripId).eq("person_id", realId).maybeSingle(),
  ]);
  if (ghostOblErr) return mergeStepFailed("prepayment_obligations.select_ghost", ghostOblErr.message);
  if (realOblErr) return mergeStepFailed("prepayment_obligations.select_real", realOblErr.message);
  if (ghostObl) {
    if (!realObl) {
      const { error } = await supabase.from("prepayment_obligations").insert({
        trip_id: tripId,
        person_id: realId,
        cabin_type_id: ghostObl.cabin_type_id,
        total_amount: ghostObl.total_amount,
      });
      if (error) return mergeStepFailed("prepayment_obligations.insert", error.message);
    }
    const { error } = await supabase.from("prepayment_obligations").delete().eq("trip_id", tripId).eq("person_id", ghostId);
    if (error) return mergeStepFailed("prepayment_obligations.delete_ghost", error.message);
  }

  // 3b. Posten-Soll (PR4a): PK (item_id, person_id). Hat real für einen
  //     Posten schon ein Soll (nur nach einem früheren Crewwechsel denkbar,
  //     Self-Klausel aus 0058), werden die Beträge addiert — wie bei den
  //     per_person-Anteilen in Schritt 2 (sonst wäre Σ Soll < Posten-Summe).
  for (const o of ghostItemObl ?? []) {
    const { data: realItemObl, error: realItemOblErr } = await supabase
      .from("prepayment_item_obligations")
      .select("amount")
      .eq("item_id", o.item_id)
      .eq("person_id", realId)
      .maybeSingle();
    if (realItemOblErr) return mergeStepFailed("prepayment_item_obligations.select_real", realItemOblErr.message);
    if (realItemObl) {
      const { error } = await supabase
        .from("prepayment_item_obligations")
        .update({ amount: Number(realItemObl.amount) + Number(o.amount) })
        .eq("item_id", o.item_id)
        .eq("trip_id", tripId)
        .eq("person_id", realId);
      if (error) return mergeStepFailed("prepayment_item_obligations.merge_amount", error.message);
      const { error: delErr } = await supabase
        .from("prepayment_item_obligations")
        .delete()
        .eq("item_id", o.item_id)
        .eq("trip_id", tripId)
        .eq("person_id", ghostId);
      if (delErr) return mergeStepFailed("prepayment_item_obligations.delete_ghost", delErr.message);
    } else {
      const { error } = await supabase
        .from("prepayment_item_obligations")
        .update({ person_id: realId })
        .eq("item_id", o.item_id)
        .eq("trip_id", tripId)
        .eq("person_id", ghostId);
      if (error) return mergeStepFailed("prepayment_item_obligations.reassign", error.message);
    }
  }

  // 4. trip_members: Ghost-Eintrag auf real umhängen. Der Pre-Check oben
  //    hat sichergestellt, dass real noch nicht Mitglied dieses Trips ist —
  //    UNIQUE (trip_id, person_id) ist daher safe.
  {
    const { error } = await supabase
      .from("trip_members")
      .update({ person_id: realId })
      .eq("trip_id", tripId)
      .eq("person_id", ghostId);
    if (error) return mergeStepFailed("trip_members.reassign", error.message);
  }

  // 4b. Posten-Empfänger (PR4a) — atomar über move_item_payee (Migration
  //     0059: Posten + credit_to der Posten-Gutschriften in einer
  //     Transaktion). Bewusst UNMITTELBAR nach dem Umhängen der Mitgliedschaft
  //     (Grill-Fund P2-4): vorher liefe ein späterer Fehlschlag darauf hinaus,
  //     dass die Gutschriften an eine Person gehen, die (noch) nicht Crew ist
  //     und deshalb aus der mitgliedschaftsgetriebenen v_balances fällt. In
  //     dieser Reihenfolge ist bis zu Schritt 4 alles konsistent beim Ghost,
  //     danach beim echten Konto. Muss vor dem persons-DELETE laufen
  //     (payee_person_id ON DELETE RESTRICT).
  for (const it of ghostPayeeItems) {
    // Gleiche Person → die Posten-Gutschriften wandern mit (p_move_credits).
    const { error } = await supabase.rpc("move_item_payee", { p_item_id: it.id, p_new_payee: realId, p_move_credits: true });
    if (error) return mergeStepFailed("prepayment_items.payee_person_id", error.message);
  }

  // 5. Trip-Skipper-FK darf nicht auf den Ghost zeigen (RESTRICT beim Delete)
  {
    const { error } = await supabase.from("trips").update({ skipper_id: realId }).eq("skipper_id", ghostId);
    if (error) return mergeStepFailed("trips.skipper_id", error.message);
  }

  // 6. Audit-Log-Spalte actor_person_id, falls Ghost je Actor war
  {
    const { error } = await supabase.from("audit_log").update({ actor_person_id: realId }).eq("actor_person_id", ghostId);
    if (error) return mergeStepFailed("audit_log.actor_person_id", error.message);
  }

  // 7. settled_debts: from_person_id / to_person_id (Schulden-Häkchen)
  {
    const { error } = await supabase.from("settled_debts").update({ from_person_id: realId }).eq("from_person_id", ghostId);
    if (error) return mergeStepFailed("settled_debts.from_person_id", error.message);
  }
  {
    const { error } = await supabase.from("settled_debts").update({ to_person_id: realId }).eq("to_person_id", ghostId);
    if (error) return mergeStepFailed("settled_debts.to_person_id", error.message);
  }

  // 7a. settled_by_person_id (Fund 5): ON DELETE SET NULL würde beim finalen
  //     persons-DELETE sonst still verlieren, WER das Häkchen gesetzt hat.
  //     Auf diesen Törn beschränkt (settled_debts.trip_id) — nach dem
  //     Pre-Check oben ist der Ghost ohnehin nur hier Crew.
  {
    const { error } = await supabase
      .from("settled_debts")
      .update({ settled_by_person_id: realId })
      .eq("trip_id", tripId)
      .eq("settled_by_person_id", ghostId);
    if (error) return mergeStepFailed("settled_debts.settled_by_person_id", error.message);
  }

  // 7b. prepayment_plan.advancer_person_id (Fund 5): ebenfalls ON DELETE SET
  //     NULL — war der Ghost als Vorstrecker eingetragen, ginge diese Rolle
  //     beim Löschen sonst still verloren und requireSkipperAdminOrAdvancer
  //     fiele unbemerkt auf den Trip-Skipper zurück.
  {
    const { error } = await supabase
      .from("prepayment_plan")
      .update({ advancer_person_id: realId })
      .eq("trip_id", tripId)
      .eq("advancer_person_id", ghostId);
    if (error) return mergeStepFailed("prepayment_plan.advancer_person_id", error.message);
  }

  // 8. Ghost-Person + persons_private löschen
  {
    const { error } = await supabase.from("persons_private").delete().eq("person_id", ghostId);
    if (error) return mergeStepFailed("persons_private.delete_ghost", error.message);
  }
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


/**
 * Plant für removeMember die Neuverteilung des Posten-Solls einer Person auf
 * die verbleibende Crew (Entscheidung M3). Rein lesend. Blockt mit einer
 * konkreten Meldung, wenn eine automatische Neuverteilung nicht sicher ist.
 */
async function planItemRedistribution(
  supabase: ReturnType<typeof createAdminClient>,
  tripId: string,
  personId: string,
  itemIds: string[],
): Promise<
  | {
      ok: true;
      redistributions: {
        itemId: string;
        rows: { person_id: string; amount: number }[];
        oldRows: { person_id: string; amount: number }[];
      }[];
    }
  | { ok: false; message: string }
> {
  const fail = (err: { message: string }) => {
    console.error("[bordkasse:db] planItemRedistribution:", err.message);
    return { ok: false as const, message: "Posten konnten nicht geprüft werden. Bitte erneut versuchen." };
  };
  const [itemsRes, txRes, tripRes, membersRes, oblRes] = await Promise.all([
    supabase.from("prepayment_items").select("id, label, total_amount, split_type").eq("trip_id", tripId).in("id", itemIds),
    supabase
      .from("transactions")
      .select("item_id, type, credit_from")
      .eq("trip_id", tripId)
      .in("item_id", itemIds)
      .is("deleted_at", null),
    supabase.from("trips").select("start_date, end_date").eq("id", tripId).maybeSingle(),
    supabase.from("trip_members").select("person_id, on_board_from, on_board_to").eq("trip_id", tripId),
    supabase.from("prepayment_item_obligations").select("item_id, person_id, amount").eq("trip_id", tripId).in("item_id", itemIds),
  ]);
  if (oblRes.error) return fail(oblRes.error);
  if (itemsRes.error) return fail(itemsRes.error);
  if (txRes.error) return fail(txRes.error);
  if (tripRes.error || !tripRes.data) return fail(tripRes.error ?? { message: "trip missing" });
  if (membersRes.error) return fail(membersRes.error);
  const trip = tripRes.data;
  const windowBy = new Map((membersRes.data ?? []).map((m) => [m.person_id as string, m]));

  const redistributions: {
    itemId: string;
    rows: { person_id: string; amount: number }[];
    oldRows: { person_id: string; amount: number }[];
  }[] = [];
  for (const item of itemsRes.data ?? []) {
    const txs = (txRes.data ?? []).filter((t) => t.item_id === item.id);
    if (txs.some((t) => t.type === "expense")) {
      return {
        ok: false,
        message:
          `Diese Person hat ein offenes Soll beim Posten „${item.label}“, für den schon an den Anbieter gezahlt wurde. ` +
          "Das Soll lässt sich nicht automatisch neu verteilen — bitte zuerst die Anbieter-Zahlung löschen oder das Soll im Posten anpassen.",
      };
    }
    if (txs.some((t) => t.type === "credit" && t.credit_from === personId)) {
      return {
        ok: false,
        message:
          `Diese Person hat für den Posten „${item.label}“ schon gezahlt oder eine Zahlung gemeldet. ` +
          "Bitte zuerst die Zahlung löschen bzw. die Meldung ablehnen, bevor du sie entfernst.",
      };
    }
    if (item.split_type !== "gleichmaessig" && item.split_type !== "zeitanteilig") {
      return {
        ok: false,
        message:
          `Diese Person hat noch ein Soll beim Posten „${item.label}“ (Einzelbeträge). ` +
          "Bitte zuerst im Posten ihren Betrag auf andere verteilen, bevor du sie entfernst.",
      };
    }
    // Delta-Review 2: NUR auf Personen verteilen, die für DIESEN Posten schon
    // eine Sollzeile haben — nicht auf die ganze aktuelle Crew (ein
    // Nachrücker, der selbst anreist, bekäme sonst fremde Flüge).
    const oldRows = (oblRes.data ?? [])
      .filter((o) => o.item_id === item.id)
      .map((o) => ({ person_id: o.person_id as string, amount: Number(o.amount) }));
    const base = oldRows.filter((o) => o.person_id !== personId);
    if (base.length === 0) {
      return {
        ok: false,
        message: `Beim Posten „${item.label}“ hat sonst niemand ein Soll. Bitte zuerst den Posten anpassen oder löschen.`,
      };
    }
    const calc = calculateItemObligations(
      item.split_type,
      Number(item.total_amount),
      base.map((o) => {
        const w = windowBy.get(o.person_id);
        return {
          personId: o.person_id,
          days: daysBetween(w?.on_board_from ?? trip.start_date, w?.on_board_to ?? trip.end_date),
        };
      }),
    );
    if (!calc.ok) return { ok: false, message: calc.message };
    redistributions.push({
      itemId: item.id as string,
      rows: calc.shares.map((sh) => ({ person_id: sh.personId, amount: sh.amount })),
      oldRows,
    });
  }
  return { ok: true, redistributions };
}
