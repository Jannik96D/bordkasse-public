"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdmin, requireMember } from "@/lib/auth/authz";
import { logAudit } from "@/lib/db/audit";
import { sendMail } from "@/lib/email/send";
import { renderDebtSettledMail } from "@/lib/email/debt-settled-template";
import { formatDate } from "@/lib/utils";

const ToggleSchema = z.object({
  trip_id: z.string().uuid(),
  from_person_id: z.string().uuid(),
  to_person_id: z.string().uuid(),
  amount: z.number().positive(),
  settled: z.boolean(),
});

/**
 * Markiert eine Schuld als bezahlt (oder hebt die Markierung auf).
 * Schlüssel: (trip_id, from_person_id, to_person_id, amount). Sobald sich
 * der Betrag durch eine neue Buchung ändert, gilt die Schuld als "neu" und
 * ist automatisch nicht mehr erledigt.
 */
export async function toggleDebtSettled(input: {
  tripId: string;
  fromPersonId: string;
  toPersonId: string;
  amount: number;
  settled: boolean;
}): Promise<{ ok: boolean; message?: string }> {
  const parsed = ToggleSchema.safeParse({
    trip_id: input.tripId,
    from_person_id: input.fromPersonId,
    to_person_id: input.toPersonId,
    amount: input.amount,
    settled: input.settled,
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe." };
  }
  const { trip_id, from_person_id, to_person_id, amount, settled } = parsed.data;

  const auth = await requireMember(trip_id);
  if (!auth.ok) return { ok: false, message: auth.message };

  // Nur die direkt Beteiligten (Schuldner oder Gläubiger) oder Admin
  // dürfen das Häkchen setzen — unbeteiligte Crew-Mitglieder nicht.
  const admin = await isAdmin();
  if (!admin && auth.personId !== from_person_id && auth.personId !== to_person_id) {
    return { ok: false, message: "Nur Schuldner oder Gläubiger dürfen das Häkchen setzen." };
  }

  const supabase = createAdminClient();

  // Bezahlt-Toggle erst freigegeben, wenn der Skipper die Abrechnung
  // offiziell verschickt hat — vorher würden Crew-Mitglieder voreilig
  // Häkchen setzen bevor alle Buchungen drin sind.
  const { data: tripState } = await supabase
    .from("trips")
    .select("settlement_announced_at")
    .eq("id", trip_id)
    .maybeSingle();
  if (!tripState?.settlement_announced_at) {
    return {
      ok: false,
      message: "Die Abrechnung wurde vom Skipper noch nicht verschickt. Bezahlt-Häkchen sind erst danach freigegeben.",
    };
  }

  if (settled) {
    const { data: row, error } = await supabase
      .from("settled_debts")
      .upsert(
        {
          trip_id,
          from_person_id,
          to_person_id,
          amount,
          settled_by_person_id: auth.personId,
          settled_at: new Date().toISOString(),
        },
        { onConflict: "trip_id,from_person_id,to_person_id,amount" },
      )
      .select("id")
      .single();
    if (error || !row) {
      if (error?.message) console.error("[bordkasse:db]", error.message);
      return { ok: false, message: "Bezahlt-Status konnte nicht gespeichert werden. Bitte erneut versuchen." };
    }
    await logAudit(supabase, {
      table_name: "settled_debts",
      operation: "INSERT",
      record_id: row.id,
      trip_id,
      actor_person_id: auth.personId,
      payload: { from_person_id, to_person_id, amount },
    });

    // Beide Seiten per Mail benachrichtigen: Schuldner bekommt eine
    // Bestätigung, Gläubiger den Hinweis „X hat seine Zahlung abgehakt —
    // bitte prüfen". Fehler beim Mailversand brechen den Toggle nicht ab,
    // werden nur geloggt.
    try {
      await sendDebtSettledMails(supabase, {
        tripId: trip_id,
        fromPersonId: from_person_id,
        toPersonId: to_person_id,
        amount,
        actorPersonId: auth.personId,
      });
    } catch (e) {
      console.error("[bordkasse:debt-settled-mail]", e);
    }
  } else {
    const { data: existing } = await supabase
      .from("settled_debts")
      .select("id")
      .eq("trip_id", trip_id)
      .eq("from_person_id", from_person_id)
      .eq("to_person_id", to_person_id)
      .eq("amount", amount)
      .maybeSingle();
    if (existing) {
      const { error } = await supabase.from("settled_debts").delete().eq("id", existing.id);
      if (error) {
        console.error("[bordkasse:db]", error.message);
        return { ok: false, message: "Bezahlt-Status konnte nicht entfernt werden. Bitte erneut versuchen." };
      }
      await logAudit(supabase, {
        table_name: "settled_debts",
        operation: "DELETE",
        record_id: existing.id,
        trip_id,
        actor_person_id: auth.personId,
        payload: { from_person_id, to_person_id, amount },
      });
    }
  }

  revalidatePath(`/trips/${trip_id}/debts`);
  return { ok: true };
}

/**
 * Schickt nach einem positiven Bezahlt-Toggle zwei Mails:
 *   - an den Schuldner (Bestätigung „Du hast abgehakt")
 *   - an den Gläubiger (Hinweis „X hat seine Zahlung abgehakt")
 *
 * Greift via Admin-Client direkt auf `persons` + `persons_private`, weil
 * der Server-Action-Pfad ohnehin Service-Role nutzt (siehe lib/auth/authz.ts).
 * Fehlt eine Mail-Adresse, wird die jeweilige Mail einfach übersprungen.
 *
 * Der Wortlaut hängt davon ab, **wer** das Häkchen tatsächlich gesetzt hat
 * (`actorPersonId`):
 *   - Schuldner selbst    → Bestätigung „du hast deine Zahlung gemeldet"
 *   - Gläubiger selbst    → Bestätigung „du hast Empfang bestätigt"
 *   - dritte Person (Admin/Skipper) → neutrales „X hat das abgehakt"
 */
async function sendDebtSettledMails(
  supabase: ReturnType<typeof createAdminClient>,
  args: {
    tripId: string;
    fromPersonId: string;
    toPersonId: string;
    amount: number;
    actorPersonId: string;
  },
): Promise<void> {
  const { data: trip } = await supabase
    .from("trips")
    .select("name, start_date, end_date")
    .eq("id", args.tripId)
    .maybeSingle();
  if (!trip) return;

  // Drei Personen-IDs sind interessant: Schuldner, Gläubiger und der Akteur.
  // Bei Selbst-Toggle (Akteur == Schuldner oder Gläubiger) reicht das Lookup
  // auf zwei IDs, weil die dritte ID identisch ist. Wir packen alle drei
  // dedupliziert in die IN-Abfrage.
  const ids = Array.from(
    new Set([args.fromPersonId, args.toPersonId, args.actorPersonId]),
  );

  const { data: personsRaw } = await supabase
    .from("persons")
    .select("id, display_name")
    .in("id", ids);
  const nameById = new Map<string, string>();
  for (const p of personsRaw ?? []) nameById.set(p.id, p.display_name);

  const { data: privsRaw } = await supabase
    .from("persons_private")
    .select("person_id, email")
    .in("person_id", [args.fromPersonId, args.toPersonId]);
  const emailById = new Map<string, string>();
  for (const p of privsRaw ?? []) if (p.email) emailById.set(p.person_id, p.email);

  const debtorName = nameById.get(args.fromPersonId) ?? "Schuldner";
  const creditorName = nameById.get(args.toPersonId) ?? "Gläubiger";
  const actorName = nameById.get(args.actorPersonId) ?? "Skipper";
  const actorRole: "debtor" | "creditor" | "other" =
    args.actorPersonId === args.fromPersonId
      ? "debtor"
      : args.actorPersonId === args.toPersonId
        ? "creditor"
        : "other";
  const tripDates = `${formatDate(trip.start_date)} – ${formatDate(trip.end_date)}`;
  const appUrl = `${process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://bordkasse.example"}/trips/${args.tripId}/debts`;

  const recipients: Array<{
    personId: string;
    role: "debtor" | "creditor";
    name: string;
  }> = [
    { personId: args.fromPersonId, role: "debtor", name: debtorName },
    { personId: args.toPersonId, role: "creditor", name: creditorName },
  ];

  for (const r of recipients) {
    const email = emailById.get(r.personId);
    if (!email) continue;
    const { html, text, subject } = renderDebtSettledMail({
      recipientName: r.name,
      recipientRole: r.role,
      actorRole,
      actorName,
      debtorName,
      creditorName,
      amount: args.amount,
      tripName: trip.name,
      tripDates,
      appUrl,
    });
    const res = await sendMail({ to: email, subject, html, text });
    if (!res.ok) {
      console.error("[bordkasse:debt-settled-mail] failed", email, res.error);
    }
  }
}
