"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdmin, requireMember } from "@/lib/auth/authz";
import { logAudit } from "@/lib/db/audit";
import { sendMail } from "@/lib/email/send";
import { renderDebtSettledMail } from "@/lib/email/debt-settled-template";
import { renderDebtObserverMail } from "@/lib/email/debt-observer-template";
import { sendPushToPersons } from "@/lib/notify/web-push";
import { pushRecipients } from "@/lib/notify/recipients";
import { debtSettledPush } from "@/lib/notify/payloads";
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
}): Promise<{ ok: boolean; message?: string; mailsSent?: number; mailsFailed?: number }> {
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
  // dürfen das Häkchen setzen — unbeteiligte Crewmitglieder nicht.
  const admin = await isAdmin();
  if (!admin && auth.personId !== from_person_id && auth.personId !== to_person_id) {
    return { ok: false, message: "Nur wer zahlt oder das Geld bekommt darf das Häkchen setzen." };
  }

  const supabase = createAdminClient();

  // Bezahlt-Toggle erst freigegeben, wenn der Skipper die Abrechnung
  // offiziell verschickt hat — vorher würden Crewmitglieder voreilig
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
    // werden nur geloggt — die Zähler reicht der Toggle an die UI durch,
    // damit ein Teilfehler sichtbar wird (Toast „1 Mail nicht zugestellt").
    let mailsSent = 0;
    let mailsFailed = 0;
    try {
      const res = await sendDebtSettledMails(supabase, {
        tripId: trip_id,
        fromPersonId: from_person_id,
        toPersonId: to_person_id,
        amount,
        actorPersonId: auth.personId,
      });
      mailsSent = res.sent;
      mailsFailed = res.failed;
    } catch (e) {
      console.error("[bordkasse:debt-settled-mail]", e);
    }

    revalidatePath(`/trips/${trip_id}/debts`);
    return { ok: true, mailsSent, mailsFailed };
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
 * Schickt nach einem positiven Bezahlt-Toggle die Mails:
 *   - an den Schuldner (Bestätigung „Du hast abgehakt")
 *   - an den Gläubiger (Hinweis „X hat seine Zahlung abgehakt")
 *   - bei Admin-/Dritt-Aktion zusätzlich an Skipper und Vorstrecker, sofern
 *     sie nicht ohnehin Schuldner oder Gläubiger sind — sie müssen wissen,
 *     dass jemand anders in ihrem Tripkontext geklickt hat.
 *
 * Greift via Admin-Client direkt auf `persons` + `persons_private`, weil
 * der Server-Action-Pfad ohnehin Service-Role nutzt (siehe lib/auth/authz.ts).
 * Fehlt eine Mail-Adresse, wird die jeweilige Mail einfach übersprungen.
 *
 * Der Wortlaut hängt davon ab, **wer** das Häkchen tatsächlich gesetzt hat
 * (`actorPersonId`):
 *   - Schuldner selbst    → Bestätigung „du hast deine Zahlung gemeldet"
 *   - Gläubiger selbst    → Bestätigung „du hast Empfang bestätigt"
 *   - dritte Person (Admin/Skipper/Vorstrecker) → neutrales „X hat abgehakt"
 *     plus Co-Empfänger Skipper + Vorstrecker als Info.
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
): Promise<{ sent: number; failed: number }> {
  const [{ data: trip }, { data: plan }] = await Promise.all([
    supabase
      .from("trips")
      .select("name, start_date, end_date, skipper_id")
      .eq("id", args.tripId)
      .maybeSingle(),
    supabase
      .from("prepayment_plan")
      .select("advancer_person_id")
      .eq("trip_id", args.tripId)
      .maybeSingle(),
  ]);
  if (!trip) return { sent: 0, failed: 0 };

  const advancerPersonId = plan?.advancer_person_id ?? trip.skipper_id;

  const actorRole: "debtor" | "creditor" | "other" =
    args.actorPersonId === args.fromPersonId
      ? "debtor"
      : args.actorPersonId === args.toPersonId
        ? "creditor"
        : "other";

  // Empfänger-Liste: immer Schuldner + Gläubiger. Bei "other"-Actor zusätzlich
  // Skipper und Vorstrecker, sofern sie nicht ohnehin schon drin sind. Sie
  // bekommen eine separate neutrale „Observer"-Mail (kein „Zahlung an DICH"-
  // Wortlaut, sondern „Schuld zwischen A und B abgehakt").
  type Recipient = { personId: string; role: "debtor" | "creditor" | "observer" };
  const recipients: Recipient[] = [
    { personId: args.fromPersonId, role: "debtor" },
    { personId: args.toPersonId, role: "creditor" },
  ];
  if (actorRole === "other") {
    const co = new Set([trip.skipper_id, advancerPersonId]);
    co.delete(args.fromPersonId);
    co.delete(args.toPersonId);
    co.delete(args.actorPersonId); // dem Actor selbst keine "Info"-Kopie
    for (const personId of co) {
      recipients.push({ personId, role: "observer" });
    }
  }

  const ids = Array.from(
    new Set([
      args.fromPersonId,
      args.toPersonId,
      args.actorPersonId,
      trip.skipper_id,
      advancerPersonId,
    ]),
  );

  const { data: personsRaw } = await supabase
    .from("persons")
    .select("id, display_name")
    .in("id", ids);
  const nameById = new Map<string, string>();
  for (const p of personsRaw ?? []) nameById.set(p.id, p.display_name);

  const recipientIds = recipients.map((r) => r.personId);
  const { data: privsRaw } = await supabase
    .from("persons_private")
    .select("person_id, email")
    .in("person_id", recipientIds);
  const emailById = new Map<string, string>();
  for (const p of privsRaw ?? []) if (p.email) emailById.set(p.person_id, p.email);

  const debtorName = nameById.get(args.fromPersonId) ?? "die zahlende Person";
  const creditorName = nameById.get(args.toPersonId) ?? "die empfangende Person";
  const actorName = nameById.get(args.actorPersonId) ?? "Skipper";
  const tripDates = `${formatDate(trip.start_date)} – ${formatDate(trip.end_date)}`;
  const appUrl = `${process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://bordkasse.example"}/trips/${args.tripId}/debts`;

  // Dedup: pro Person-ID nur EINE Mail (falls jemand sowohl Skipper als
  // auch Vorstrecker und gleichzeitig Schuldner ist → erste Rolle gewinnt).
  const seen = new Set<string>();
  let sent = 0;
  let failed = 0;

  for (const r of recipients) {
    if (seen.has(r.personId)) continue;
    seen.add(r.personId);
    const email = emailById.get(r.personId);
    // Kein Empfänger ohne Mail-Adresse zählt als Fehler — er wird einfach
    // übersprungen (z. B. Ghost-Crew). Nur echte Zustell-Fehler zählen.
    if (!email) continue;

    const recipientName = nameById.get(r.personId) ?? "Crewmitglied";

    // Observer-Pfad (neutraler Info-Mailtext): Skipper/Vorstrecker, die
    // weder Schuldner noch Gläubiger sind, bekommen eine separate Mail mit
    // „Schuld zwischen A und B abgehakt"-Wortlaut. Die normale
    // debt-settled-Mail würde sie sonst irreführend als „Gläubiger" /
    // „Schuldner" adressieren.
    if (r.role === "observer") {
      // Jeder Observer ist garantiert Skipper oder Vorstrecker (die Liste wird
      // nur aus diesen beiden IDs gebaut). Bei Personalunion gewinnt „skipper".
      const recipientReason: "skipper" | "advancer" =
        r.personId === trip.skipper_id ? "skipper" : "advancer";
      const { html, text, subject } = renderDebtObserverMail({
        recipientName,
        recipientReason,
        actorName,
        debtorName,
        creditorName,
        amount: args.amount,
        tripName: trip.name,
        tripDates,
        appUrl,
      });
      const res = await sendMail({ to: email, subject, html, text });
      if (res.ok) {
        sent += 1;
      } else {
        failed += 1;
        console.error("[bordkasse:debt-settled-mail] observer failed", {
          person_id: r.personId,
          error: res.error,
        });
      }
      continue;
    }

    const { html, text, subject } = renderDebtSettledMail({
      recipientName,
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
    if (res.ok) {
      sent += 1;
    } else {
      failed += 1;
      // PII (Mail-Adresse) bewusst NICHT loggen.
      console.error("[bordkasse:debt-settled-mail] failed", { person_id: r.personId, error: res.error });
    }
  }

  // Push (additiv zur Mail) — nur an die direkt Beteiligten (Schuldner /
  // Gläubiger), NIE an Observer und nie an den Auslöser selbst. Schuldner und
  // Gläubiger bekommen unterschiedlichen Text, daher pro Empfänger ein Push.
  for (const pid of pushRecipients([args.fromPersonId, args.toPersonId], {
    excludeActorId: args.actorPersonId,
  })) {
    await sendPushToPersons(
      supabase,
      [pid],
      debtSettledPush({
        recipientRole: pid === args.fromPersonId ? "debtor" : "creditor",
        actorRole,
        actorName,
        amount: args.amount,
        tripId: args.tripId,
        fromPersonId: args.fromPersonId,
        toPersonId: args.toPersonId,
      }),
    );
  }

  return { sent, failed };
}

