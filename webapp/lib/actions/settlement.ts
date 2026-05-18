"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { requireSkipperOrAdmin } from "@/lib/auth/authz";
import { logAudit } from "@/lib/db/audit";
import { getBalances, getSimplifiedDebts } from "@/lib/queries/balances";
import { sendMail } from "@/lib/email/send";
import { renderSettlementMail, type DebtItem } from "@/lib/email/settlement-template";
import { formatDate } from "@/lib/utils";

type Result =
  | { ok: true; sent: number; skipped: number }
  | { ok: false; message: string };

/**
 * Markiert den Trip als "Abrechnung erfolgt" und schickt jedem Crew-Mitglied
 * eine personalisierte Mail mit:
 *   - eigenem Saldo (positiv = bekommt zurück, negativ = zahlt noch)
 *   - konkretem Zahlungs-/Empfangs-Plan aus simplify_debts()
 *   - Link zur Bilanz-Seite
 *
 * Sobald `settlement_announced_at` gesetzt ist, sind die Bezahlt-Toggles in
 * der Schulden-Ansicht freigeschaltet (siehe settled-debts.ts).
 *
 * Erlaubt nur Skipper/Co-Skipper/Admin. Idempotent: ist das Flag schon
 * gesetzt, gibt es einen freundlichen Hinweis ohne erneuten Mailversand.
 */
export async function announceSettlement(tripId: string): Promise<Result> {
  const person = await getCurrentPerson();
  if (!person) return { ok: false, message: "Nicht angemeldet." };

  const auth = await requireSkipperOrAdmin(tripId);
  if (!auth.ok) {
    return { ok: false, message: auth.message };
  }

  const supabase = createAdminClient();

  // Trip + bereits angekündigt? Idempotenz.
  const { data: trip } = await supabase
    .from("trips")
    .select("id, name, start_date, end_date, settlement_announced_at")
    .eq("id", tripId)
    .maybeSingle();
  if (!trip) return { ok: false, message: "Törn nicht gefunden." };
  if (trip.settlement_announced_at) {
    return { ok: false, message: "Abrechnung wurde bereits verschickt." };
  }

  // Aktuelle Bilanz + Schulden-Plan ziehen.
  const [balances, debts] = await Promise.all([
    getBalances(tripId),
    getSimplifiedDebts(tripId),
  ]);

  // Crew + Mails laden (über Admin-Client, RLS-Bypass).
  type MemberRow = {
    person_id: string;
    person: { display_name: string } | { display_name: string }[] | null;
  };
  const { data: membersRaw } = await supabase
    .from("trip_members")
    .select(`
      person_id,
      person:persons(display_name)
    `)
    .eq("trip_id", tripId);
  const members = (membersRaw ?? []) as unknown as MemberRow[];
  const displayName = (m: MemberRow) =>
    (Array.isArray(m.person) ? m.person[0]?.display_name : m.person?.display_name) ?? "";

  const { data: privs } = await supabase
    .from("persons_private")
    .select("person_id, email")
    .in("person_id", members.map((m) => m.person_id));
  const emailById = new Map<string, string>();
  for (const p of privs ?? []) if (p.email) emailById.set(p.person_id, p.email);

  // Skipper-Name für die Anrede in der Mail.
  const skipperRow = members.find((m) => m.person_id === person.id);
  const skipperName = skipperRow ? displayName(skipperRow) : "Skipper";

  const tripDates = `${formatDate(trip.start_date)} – ${formatDate(trip.end_date)}`;
  // Link führt direkt zu den Schulden — dort sieht das Crew-Mitglied den
  // Zahlungsplan und kann erledigte Zahlungen abhaken. Für den Gesamt-Saldo
  // ist der Bilanz-Tab nur einen Tap entfernt.
  const appUrl = `${process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://bordkasse.example"}/trips/${tripId}/debts`;

  let sent = 0;
  let skipped = 0;

  for (const m of members) {
    const email = emailById.get(m.person_id);
    if (!email) {
      skipped += 1;
      continue;
    }
    const balanceRow = balances.find((b) => b.person_id === m.person_id);
    const recipientName = displayName(m);

    // Zahlungsanweisungen aus dem Schulden-Plan
    const myDebts: DebtItem[] = [];
    for (const d of debts) {
      if (d.from_person_id === m.person_id) {
        myDebts.push({
          counterparty_name: d.to_name,
          amount: d.amount,
          direction: "owes",
        });
      } else if (d.to_person_id === m.person_id) {
        myDebts.push({
          counterparty_name: d.from_name,
          amount: d.amount,
          direction: "receives",
        });
      }
    }

    const { html, text, subject } = renderSettlementMail({
      recipientName,
      tripName: trip.name,
      tripDates,
      balance: balanceRow?.balance ?? 0,
      debts: myDebts,
      appUrl,
      skipperName,
    });

    const res = await sendMail({ to: email, subject, html, text });
    if (res.ok) sent += 1;
    else {
      skipped += 1;
      console.error("[bordkasse:settlement] mail failed", email, res.error);
    }
  }

  // Flag setzen — auch wenn manche Mails fehlschlugen (UI kann's später
  // re-triggern, aber der Schulden-Toggle soll jetzt freigeschaltet sein).
  const { error: updateErr } = await supabase
    .from("trips")
    .update({
      settlement_announced_at: new Date().toISOString(),
      settlement_announced_by: person.id,
    })
    .eq("id", tripId);
  if (updateErr) {
    console.error("[bordkasse:db]", updateErr.message);
    return { ok: false, message: "Konnte Abrechnungs-Flag nicht setzen." };
  }

  await logAudit(supabase, {
    table_name: "trips",
    operation: "UPDATE",
    record_id: tripId,
    trip_id: tripId,
    actor_person_id: person.id,
    payload: { settlement_announced: true, mails_sent: sent, mails_skipped: skipped },
  });

  revalidatePath(`/trips/${tripId}`);
  revalidatePath(`/trips/${tripId}/balance`);
  revalidatePath(`/trips/${tripId}/debts`);
  return { ok: true, sent, skipped };
}
