"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { requireMember, requireSkipperOrAdmin } from "@/lib/auth/authz";
import { logAudit } from "@/lib/db/audit";
import { getBalances, getSimplifiedDebts } from "@/lib/queries/balances";
import { sendMail } from "@/lib/email/send";
import { renderSettlementMail, type DebtItem } from "@/lib/email/settlement-template";
import { sendPushToPersons } from "@/lib/notify/web-push";
import { pushRecipients } from "@/lib/notify/recipients";
import { settlementAnnouncedPush, settlementUpdatedPush } from "@/lib/notify/payloads";
import { formatDate } from "@/lib/utils";

type Result =
  // skipped = kein E-Mail-Adresse hinterlegt (z. B. Ghost-Crew); failed =
  // Adresse vorhanden, aber Zustellung schlug fehl. Getrennt, damit die UI
  // einen echten Teilfehler von „kein Postfach" unterscheiden kann.
  | { ok: true; sent: number; skipped: number; failed: number }
  | { ok: false; message: string };

/**
 * Markiert den Trip als "Abrechnung erfolgt" und schickt jedem Crewmitglied
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
    .select("id, name, start_date, end_date, settlement_announced_at, trip_type")
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
  const tripType: "sailing" | "other" = trip.trip_type === "other" ? "other" : "sailing";
  // Link führt direkt zu den Schulden — dort sieht das Crewmitglied den
  // Zahlungsplan und kann erledigte Zahlungen abhaken. Für den Gesamt-Saldo
  // ist der Bilanz-Tab nur einen Tap entfernt.
  const appUrl = `${process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://bordkasse.example"}/trips/${tripId}/debts`;

  let sent = 0;
  let skipped = 0;
  let failed = 0;

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
      tripType,
    });

    const res = await sendMail({ to: email, subject, html, text });
    if (res.ok) sent += 1;
    else {
      failed += 1;
      // PII (Mail-Adresse) bewusst NICHT loggen — Person-ID reicht für Diagnose.
      console.error("[bordkasse:settlement] mail failed", { person_id: m.person_id, error: res.error });
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
    payload: { settlement_announced: true, mails_sent: sent, mails_skipped: skipped, mails_failed: failed },
  });

  // Push zusätzlich zur Mail (additiv, wirft nie). Den Auslöser selbst pushen
  // wir nicht — er hat die Abrechnung gerade ausgelöst.
  await sendPushToPersons(
    supabase,
    pushRecipients(members.map((m) => m.person_id), { excludeActorId: person.id }),
    settlementAnnouncedPush(trip.name, tripId),
  );

  revalidatePath(`/trips/${tripId}`);
  revalidatePath(`/trips/${tripId}/balance`);
  revalidatePath(`/trips/${tripId}/debts`);
  return { ok: true, sent, skipped, failed };
}

/**
 * Schickt eine Update-Mail an die Crew, nachdem sich seit der ersten
 * Abrechnung Buchungen geändert haben (neu/bearbeitet/gelöscht). Setzt
 * `last_settlement_resend_at` und löscht den `changes_pending_since`-Marker.
 *
 * Ablauf wie `announceSettlement`, aber:
 *   - setzt isUpdate = true im Mail-Template (Wortlaut "Bilanz aktualisiert")
 *   - aktualisiert NICHT `settlement_announced_at` (war schon gesetzt)
 *   - liest `changes_pending_since` für den Zeitstempel des Diffs
 *   - aggregiert eine kurze changeSummary aus dem Audit-Log seit dem letzten
 *     Mailversand (Anzahl: neu / geändert / gelöscht)
 */
export async function resendSettlement(tripId: string): Promise<Result> {
  const person = await getCurrentPerson();
  if (!person) return { ok: false, message: "Nicht angemeldet." };

  // Jeder Trip-Member darf die Update-Mail auslösen — typischerweise will
  // die Person, die soeben eine nachträgliche Buchung erfasst hat, die Mail
  // direkt selbst raushauen, ohne den Skipper bemühen zu müssen. Spam ist
  // ausgeschlossen, weil der Resend nur funktioniert, wenn
  // `changes_pending_since` gesetzt ist — und das Flag wird nach jedem
  // erfolgreichen Versand gelöscht.
  const auth = await requireMember(tripId);
  if (!auth.ok) return { ok: false, message: auth.message };

  const supabase = createAdminClient();

  const { data: trip } = await supabase
    .from("trips")
    .select(
      "id, name, start_date, end_date, settlement_announced_at, changes_pending_since, last_settlement_resend_at, trip_type",
    )
    .eq("id", tripId)
    .maybeSingle();
  if (!trip) return { ok: false, message: "Törn nicht gefunden." };
  if (!trip.settlement_announced_at) {
    return {
      ok: false,
      message:
        "Es wurde noch keine Abrechnung verschickt. Bitte erst die initiale Abrechnung verschicken.",
    };
  }

  // Diff-Hinweis aus dem Audit-Log: alle Transaktions-Änderungen seit dem
  // Marker (oder seit dem letzten Resend / der initialen Abrechnung).
  const since =
    trip.changes_pending_since ??
    trip.last_settlement_resend_at ??
    trip.settlement_announced_at;
  let changeSummary: string | undefined;
  try {
    const { data: logRows } = await supabase
      .from("audit_log")
      .select("operation, table_name")
      .eq("trip_id", tripId)
      .in("table_name", ["transactions"])
      .gte("created_at", since);
    const rows = logRows ?? [];
    let created = 0;
    let updated = 0;
    let deleted = 0;
    for (const r of rows) {
      if (r.operation === "INSERT") created += 1;
      else if (r.operation === "UPDATE") updated += 1;
      else if (r.operation === "DELETE") deleted += 1;
    }
    const parts: string[] = [];
    if (created > 0) parts.push(`${created} neu`);
    if (updated > 0) parts.push(`${updated} geändert`);
    if (deleted > 0) parts.push(`${deleted} gelöscht`);
    if (parts.length > 0) changeSummary = parts.join(", ");
  } catch (e) {
    // Audit-Log ist optional — fehlt der Diff, schicken wir die Mail trotzdem.
    console.error("[bordkasse:settlement-resend] audit summary failed", e);
  }

  const [balances, debts] = await Promise.all([
    getBalances(tripId),
    getSimplifiedDebts(tripId),
  ]);

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

  const skipperRow = members.find((m) => m.person_id === person.id);
  const skipperName = skipperRow ? displayName(skipperRow) : "Skipper";

  const tripDates = `${formatDate(trip.start_date)} – ${formatDate(trip.end_date)}`;
  const tripType: "sailing" | "other" = trip.trip_type === "other" ? "other" : "sailing";
  const appUrl = `${process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://bordkasse.example"}/trips/${tripId}/debts`;

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const m of members) {
    const email = emailById.get(m.person_id);
    if (!email) {
      skipped += 1;
      continue;
    }
    const balanceRow = balances.find((b) => b.person_id === m.person_id);
    const recipientName = displayName(m);

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
      isUpdate: true,
      changeSummary,
      tripType,
    });

    const res = await sendMail({ to: email, subject, html, text });
    if (res.ok) sent += 1;
    else {
      failed += 1;
      console.error("[bordkasse:settlement-resend] mail failed", { person_id: m.person_id, error: res.error });
    }
  }

  // Marker zurücksetzen + Audit. Bei Mail-Fehlern bleibt der Marker bestehen,
  // damit der Skipper es erneut versuchen kann.
  if (sent > 0) {
    const { error: updateErr } = await supabase
      .from("trips")
      .update({
        last_settlement_resend_at: new Date().toISOString(),
        changes_pending_since: null,
      })
      .eq("id", tripId);
    if (updateErr) {
      console.error("[bordkasse:db]", updateErr.message);
      return { ok: false, message: "Konnte Resend-Marker nicht aktualisieren." };
    }
  }

  await logAudit(supabase, {
    table_name: "trips",
    operation: "UPDATE",
    record_id: tripId,
    trip_id: tripId,
    actor_person_id: person.id,
    payload: {
      settlement_resend: true,
      mails_sent: sent,
      mails_skipped: skipped,
      mails_failed: failed,
      change_summary: changeSummary ?? null,
    },
  });

  // Push zusätzlich zur Update-Mail (gleicher Collapse-Tag wie die
  // Ankündigung → ersetzt sie). Auslöser ausgenommen.
  await sendPushToPersons(
    supabase,
    pushRecipients(members.map((m) => m.person_id), { excludeActorId: person.id }),
    settlementUpdatedPush(trip.name, tripId),
  );

  revalidatePath(`/trips/${tripId}`);
  revalidatePath(`/trips/${tripId}/balance`);
  revalidatePath(`/trips/${tripId}/debts`);
  return { ok: true, sent, skipped, failed };
}
