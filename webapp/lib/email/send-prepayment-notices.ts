/**
 * Versand der Benachrichtigungen für Reise-Posten und den Anzahlungsplan
 * (PR6). Die Regeln (wer bekommt was, Wero, Fristen) stehen rein und
 * getestet in lib/prepayments/notify.ts; hier werden nur Daten geladen,
 * Mails gerendert/verschickt und Pushes additiv hinterhergeschickt.
 *
 * Vertrag für ALLE Funktionen hier: sie WERFEN NIE. Der Aufrufer (eine
 * Server-Action) hat seine eigentliche Schreiboperation zu diesem Zeitpunkt
 * schon erfolgreich abgeschlossen — ein Mail-/DB-Fehler hier darf sie nicht
 * im Nachhinein als gescheitert erscheinen lassen. Ergebnis ist eine Zählung
 * `{sent, failed, skipped}` (skipped = keine E-Mail-Adresse hinterlegt),
 * Fehler landen ohne Adressen/Namen im Serverlog.
 *
 * Reihenfolge je Ereignis: erst alle Mails (gebündelt über sendMails), DANN
 * die Pushes (additiv, docs/push-notifications.md).
 */

import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { sendMails, type MailMessage } from "@/lib/email/send";
import { sendPushToPersons } from "@/lib/notify/web-push";
import {
  itemAnnouncedPush,
  itemPaymentNoticePush,
  itemPaymentPendingPush,
  planAnnouncedPush,
  type PushPayload,
} from "@/lib/notify/payloads";
import { renderItemNoticeMail, renderItemPendingMail } from "@/lib/email/item-notice-template";
import {
  renderItemAnnounceCrewMail,
  renderItemAnnouncePayeeMail,
  renderPlanAnnounceAdvancerMail,
  renderPlanAnnounceCrewMail,
} from "@/lib/email/announce-templates";
import {
  announceRecipients,
  crewDueLabel,
  itemNoticeRecipients,
  normalizeWeroId,
  trancheShare,
  weroIdForItem,
  type ItemNoticeKind,
} from "@/lib/prepayments/notify";
import { formatDeDate } from "@/lib/prepayments/dates";
import { appOrigin } from "@/lib/auth/origin";
import { tripVocab } from "@/lib/trip-vocab";
import { round2 } from "@/lib/utils";

type AdminClient = ReturnType<typeof createAdminClient>;
type TripType = "sailing" | "other";

export interface NoticeResult {
  sent: number;
  failed: number;
  /** Empfänger ohne hinterlegte E-Mail-Adresse. */
  skipped: number;
  /** Gesetzt, wenn schon das Laden der Daten scheiterte (dann ist nichts verschickt). */
  error?: string;
}

/**
 * Knappe SMTP-Timeouts (Grill-Fund P2-3): der Versand läuft synchron am Ende
 * einer Server-Action, deren Schreiboperation schon fertig ist — ein hängender
 * Mailserver soll den Nutzer nicht minutenlang warten (und erneut klicken)
 * lassen.
 */
const NOTICE_MAIL_TIMEOUTS = { connectionTimeoutMs: 10_000, greetingTimeoutMs: 10_000, socketTimeoutMs: 15_000 } as const;

const EMPTY: NoticeResult = { sent: 0, failed: 0, skipped: 0 };
const LOG = "[bordkasse:prepayment-notice]";

function loadError(what: string, message: string): NoticeResult {
  console.error(LOG, `${what}:`, message);
  return { ...EMPTY, error: `${what} konnten nicht geladen werden.` };
}

const prepaymentsUrl = (tripId: string) => `${appOrigin()}/trips/${tripId}/prepayments`;

async function loadTrip(
  supabase: AdminClient,
  tripId: string,
): Promise<{ ok: true; name: string; tripType: TripType; skipperId: string | null } | { ok: false; message: string }> {
  const { data, error } = await supabase.from("trips").select("name, trip_type, skipper_id").eq("id", tripId).maybeSingle();
  if (error) return { ok: false, message: error.message };
  if (!data) return { ok: false, message: "trip not found" };
  return {
    ok: true,
    name: data.name as string,
    tripType: data.trip_type === "other" ? "other" : "sailing",
    skipperId: (data.skipper_id as string | null) ?? null,
  };
}

async function loadPeople(
  supabase: AdminClient,
  nameIds: string[],
  emailIds: string[],
): Promise<{ ok: true; name: Map<string, string>; email: Map<string, string> } | { ok: false; message: string }> {
  const [pRes, eRes] = await Promise.all([
    nameIds.length ? supabase.from("persons").select("id, display_name").in("id", nameIds) : Promise.resolve({ data: [], error: null }),
    emailIds.length
      ? supabase.from("persons_private").select("person_id, email").in("person_id", emailIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (pRes.error) return { ok: false, message: pRes.error.message };
  if (eRes.error) return { ok: false, message: eRes.error.message };
  const name = new Map<string, string>();
  for (const p of (pRes.data ?? []) as { id: string; display_name: string }[]) name.set(p.id, p.display_name);
  const email = new Map<string, string>();
  for (const p of (eRes.data ?? []) as { person_id: string; email: string | null }[]) if (p.email) email.set(p.person_id, p.email);
  return { ok: true, name, email };
}

interface Outgoing {
  personId: string;
  mail: { subject: string; html: string; text: string };
  push: PushPayload;
}

/** Mails gebündelt verschicken, danach Pushes; wirft nie. */
async function deliver(supabase: AdminClient, email: Map<string, string>, out: Outgoing[], kind: string): Promise<NoticeResult> {
  const result: NoticeResult = { ...EMPTY };
  try {
    const withMail = out.filter((o) => email.has(o.personId));
    result.skipped = out.length - withMail.length;
    const messages: MailMessage[] = withMail.map((o) => ({
      to: email.get(o.personId)!,
      subject: o.mail.subject,
      html: o.mail.html,
      text: o.mail.text,
    }));
    const sent = await sendMails(messages, NOTICE_MAIL_TIMEOUTS);
    for (const r of sent) {
      if (r.ok) result.sent += 1;
      else result.failed += 1;
    }
    if (result.failed > 0) console.error(LOG, kind, { sent: result.sent, failed: result.failed });
  } catch (err) {
    console.error(LOG, kind, "Mailversand:", err instanceof Error ? err.message : String(err));
    result.failed = out.length - result.skipped;
  }
  // Push additiv nach der Mail — sendPushToPersons wirft selbst nie.
  await Promise.all(out.map((o) => sendPushToPersons(supabase, [o.personId], o.push)));
  return result;
}

// ────────────────────────────────────────────────────────────────────────
// Posten: Kontext laden
// ────────────────────────────────────────────────────────────────────────

interface ItemContext {
  trip: { name: string; tripType: TripType; skipperId: string | null };
  item: {
    id: string;
    label: string;
    categoryName: string | null;
    totalAmount: number;
    dueDate: string | null;
    payeeId: string;
  };
}

async function loadItemContext(
  supabase: AdminClient,
  tripId: string,
  itemId: string,
): Promise<{ ok: true; ctx: ItemContext } | { ok: false; message: string }> {
  const [trip, itemRes] = await Promise.all([
    loadTrip(supabase, tripId),
    supabase
      .from("prepayment_items")
      .select("id, label, category_id, total_amount, due_date, payee_person_id")
      .eq("id", itemId)
      .eq("trip_id", tripId)
      .maybeSingle(),
  ]);
  if (!trip.ok) return trip;
  if (itemRes.error) return { ok: false, message: itemRes.error.message };
  if (!itemRes.data) return { ok: false, message: "item not found" };
  const it = itemRes.data;
  let categoryName: string | null = null;
  if (it.category_id) {
    const { data: cat, error } = await supabase
      .from("trip_categories")
      .select("name")
      .eq("id", it.category_id)
      .eq("trip_id", tripId)
      .maybeSingle();
    // Kategorie ist nur Zierde — ein Lesefehler lässt sie weg, statt die Mail zu verhindern.
    if (error) console.error(LOG, "Kategorie:", error.message);
    categoryName = (cat?.name as string | undefined) ?? null;
  }
  return {
    ok: true,
    ctx: {
      trip: { name: trip.name, tripType: trip.tripType, skipperId: trip.skipperId },
      item: {
        id: it.id as string,
        label: it.label as string,
        categoryName,
        totalAmount: Number(it.total_amount),
        dueDate: (it.due_date as string | null) ?? null,
        payeeId: it.payee_person_id as string,
      },
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Posten: Selbstmeldung → Empfänger
// ────────────────────────────────────────────────────────────────────────

export async function sendItemPendingNotice(
  supabase: AdminClient,
  args: { tripId: string; itemId: string; actorId: string; amount: number; date: string; note?: string | null },
): Promise<NoticeResult> {
  try {
    const loaded = await loadItemContext(supabase, args.tripId, args.itemId);
    if (!loaded.ok) return loadError("Posten", loaded.message);
    const { trip, item } = loaded.ctx;
    // Meldet der Empfänger für sich selbst, gibt es niemanden zu informieren.
    if (item.payeeId === args.actorId) return { ...EMPTY };
    const people = await loadPeople(supabase, [item.payeeId, args.actorId], [item.payeeId]);
    if (!people.ok) return loadError("Personen", people.message);
    const reporterName = people.name.get(args.actorId) ?? "Ein Crewmitglied";
    const mail = renderItemPendingMail({
      recipientName: people.name.get(item.payeeId) ?? tripVocab(trip.tripType).member,
      reporterName,
      tripName: trip.name,
      tripType: trip.tripType,
      item: { label: item.label, categoryName: item.categoryName },
      amount: args.amount,
      date: formatDeDate(args.date),
      note: args.note || null,
      appUrl: prepaymentsUrl(args.tripId),
    });
    return deliver(
      supabase,
      people.email,
      [
        {
          personId: item.payeeId,
          mail,
          push: itemPaymentPendingPush({
            payerName: reporterName,
            itemLabel: item.label,
            amount: args.amount,
            tripId: args.tripId,
            itemId: item.id,
            payerPersonId: args.actorId,
          }),
        },
      ],
      "item-pending",
    );
  } catch (err) {
    console.error(LOG, "item-pending:", err instanceof Error ? err.message : String(err));
    return { ...EMPTY, error: "Benachrichtigung fehlgeschlagen." };
  }
}

// ────────────────────────────────────────────────────────────────────────
// Posten: erfasst / bestätigt / abgelehnt → zahlende Person (+ Empfänger)
// ────────────────────────────────────────────────────────────────────────

export async function sendItemPaymentNotices(
  supabase: AdminClient,
  args: { kind: ItemNoticeKind; tripId: string; itemId: string; actorId: string; payerId: string | null; amount: number },
): Promise<NoticeResult> {
  try {
    const loaded = await loadItemContext(supabase, args.tripId, args.itemId);
    if (!loaded.ok) return loadError("Posten", loaded.message);
    const { trip, item } = loaded.ctx;
    const recipients = itemNoticeRecipients({ actorId: args.actorId, payerId: args.payerId, payeeId: item.payeeId });
    if (recipients.length === 0) return { ...EMPTY };
    const nameIds = [args.actorId, item.payeeId, ...(args.payerId ? [args.payerId] : [])];
    const people = await loadPeople(supabase, [...new Set(nameIds)], recipients.map((r) => r.personId));
    if (!people.ok) return loadError("Personen", people.message);
    const payerName = (args.payerId && people.name.get(args.payerId)) || "Ein Crewmitglied";
    const payeeName = people.name.get(item.payeeId) ?? "die empfangende Person";
    const vocab = tripVocab(trip.tripType);
    const actorName = people.name.get(args.actorId) ?? vocab.skipper;
    const out: Outgoing[] = recipients.map((r) => ({
      personId: r.personId,
      mail: renderItemNoticeMail({
        kind: args.kind,
        role: r.role,
        recipientName: people.name.get(r.personId) ?? vocab.member,
        actorName,
        payerName,
        payeeName,
        tripName: trip.name,
        tripType: trip.tripType,
        item: { label: item.label, categoryName: item.categoryName },
        amount: args.amount,
        appUrl: prepaymentsUrl(args.tripId),
      }),
      push: itemPaymentNoticePush({
        kind: args.kind,
        role: r.role,
        payerName,
        itemLabel: item.label,
        amount: args.amount,
        tripId: args.tripId,
      }),
    }));
    return deliver(supabase, people.email, out, args.kind);
  } catch (err) {
    console.error(LOG, args.kind, err instanceof Error ? err.message : String(err));
    return { ...EMPTY, error: "Benachrichtigung fehlgeschlagen." };
  }
}

// ────────────────────────────────────────────────────────────────────────
// Posten: „angelegt" / „geändert"
// ────────────────────────────────────────────────────────────────────────

export async function sendItemAnnouncement(
  supabase: AdminClient,
  args: { tripId: string; itemId: string; actorId: string | null; isUpdate: boolean; todayIso?: string },
): Promise<NoticeResult> {
  try {
    const loaded = await loadItemContext(supabase, args.tripId, args.itemId);
    if (!loaded.ok) return loadError("Posten", loaded.message);
    const { trip, item } = loaded.ctx;

    const [oblRes, planRes, paidRes] = await Promise.all([
      supabase
        .from("prepayment_item_obligations")
        .select("person_id, amount")
        .eq("trip_id", args.tripId)
        .eq("item_id", item.id),
      supabase.from("prepayment_plan").select("wero_id, advancer_person_id").eq("trip_id", args.tripId).maybeSingle(),
      // Bereits bestätigte Zahlungen: die Update-Mail fordert niemanden auf,
      // schon Bezahltes erneut zu zahlen (Grill-Fund P2-1).
      supabase
        .from("v_prepayment_item_payments")
        .select("person_id, paid_amount")
        .eq("trip_id", args.tripId)
        .eq("item_id", item.id),
    ]);
    if (oblRes.error) return loadError("Sollbeträge", oblRes.error.message);
    // Fail-closed: ohne bekannte Zahlungen lieber keine Mail als eine
    // Zahlungsaufforderung an jemanden, der schon gezahlt hat.
    if (paidRes.error) return loadError("Zahlungen", paidRes.error.message);
    const paidBy = new Map<string, number>();
    for (const r of paidRes.data ?? []) paidBy.set(r.person_id as string, Number(r.paid_amount));
    // Ohne lesbaren Plan einfach keine Wero-ID (Wero ist optional).
    if (planRes.error) console.error(LOG, "Plan (Wero):", planRes.error.message);
    const soll = (oblRes.data ?? []).map((o) => ({ personId: o.person_id as string, amount: Number(o.amount) }));
    const { crew, payeeId } = announceRecipients({ soll, payeeId: item.payeeId, actorId: args.actorId });
    if (crew.length === 0 && !payeeId) return { ...EMPTY };

    const advancerId = (planRes.data?.advancer_person_id as string | null | undefined) ?? trip.skipperId;
    const weroId = weroIdForItem({
      planWeroId: (planRes.data?.wero_id as string | null | undefined) ?? null,
      advancerId: planRes.data ? advancerId : null,
      payeeId: item.payeeId,
    });

    const allSollIds = soll.filter((s) => s.amount > 0.005).map((s) => s.personId);
    const people = await loadPeople(
      supabase,
      [...new Set([...allSollIds, item.payeeId])],
      [...crew.map((c) => c.personId), ...(payeeId ? [payeeId] : [])],
    );
    if (!people.ok) return loadError("Personen", people.message);
    const payeeName = people.name.get(item.payeeId) ?? "die empfangende Person";
    const itemInfo = { label: item.label, categoryName: item.categoryName };
    const crewDue = crewDueLabel(item.dueDate, args.todayIso);
    const appUrl = prepaymentsUrl(args.tripId);

    const out: Outgoing[] = crew.map((c) => ({
      personId: c.personId,
      mail: renderItemAnnounceCrewMail({
        isUpdate: args.isUpdate,
        recipientName: people.name.get(c.personId) ?? "",
        payeeName,
        tripName: trip.name,
        tripType: trip.tripType,
        item: itemInfo,
        amount: c.amount,
        paid: paidBy.get(c.personId) ?? 0,
        crewDue,
        weroId,
        appUrl,
      }),
      push: itemAnnouncedPush({
        isUpdate: args.isUpdate,
        itemLabel: item.label,
        amount: c.amount,
        tripName: trip.name,
        tripId: args.tripId,
        itemId: item.id,
      }),
    }));
    if (payeeId) {
      const own = soll.find((s) => s.personId === payeeId)?.amount ?? 0;
      const rows = soll
        .filter((s) => s.personId !== payeeId && s.amount > 0.005)
        .map((s) => ({ name: people.name.get(s.personId) ?? "", amount: round2(s.amount) }))
        .sort((a, b) => a.name.localeCompare(b.name, "de"));
      out.push({
        personId: payeeId,
        mail: renderItemAnnouncePayeeMail({
          isUpdate: args.isUpdate,
          recipientName: payeeName,
          tripName: trip.name,
          tripType: trip.tripType,
          item: itemInfo,
          total: item.totalAmount,
          providerDue: item.dueDate ? formatDeDate(item.dueDate) : null,
          rows,
          ownAmount: round2(own),
          appUrl,
        }),
        push: itemAnnouncedPush({
          isUpdate: args.isUpdate,
          itemLabel: item.label,
          amount: null,
          tripName: trip.name,
          tripId: args.tripId,
          itemId: item.id,
        }),
      });
    }

    const result = await deliver(supabase, people.email, out, args.isUpdate ? "item-update" : "item-created");
    if (result.sent > 0) {
      const { error } = await supabase
        .from("prepayment_items")
        .update({ crew_last_notified_at: new Date().toISOString() })
        .eq("id", item.id)
        .eq("trip_id", args.tripId);
      // Fail-soft (z. B. Migration 0062 fehlt): nur die Anzeige „zuletzt informiert" fehlt.
      if (error) console.error(LOG, "crew_last_notified_at (Posten):", error.message);
    }
    return result;
  } catch (err) {
    console.error(LOG, "item-announce:", err instanceof Error ? err.message : String(err));
    return { ...EMPTY, error: "Benachrichtigung fehlgeschlagen." };
  }
}

// ────────────────────────────────────────────────────────────────────────
// Anzahlungsplan: „angelegt" (einmalig) / „geändert"
// ────────────────────────────────────────────────────────────────────────

/**
 * Wird nach jedem erfolgreichen saveTranches aufgerufen. Verschickt die Mail
 * „Anzahlungsplan angelegt" GENAU EINMAL pro Plan: der Versand wird atomar
 * über `prepayment_plan.crew_notified_at` (Migration 0062) beansprucht —
 * nur der Request, dessen UPDATE … WHERE crew_notified_at IS NULL die Zeile
 * trifft, verschickt. Ein Doppelklick/Retry oder jedes spätere Speichern im
 * Wizard findet das Flag gesetzt und verschickt nichts. Fehlt die Spalte
 * (App vor Migration), scheitert der Claim → es wird NICHTS verschickt.
 *
 * Zwei Vorbedingungen vor dem Claim (Grill-Funde P2-2/P2-4):
 *   • `firstSetup`: der aufrufende saveTranches-Request hat die ERSTEN
 *     Tranchen dieses Plans angelegt (vorher gab es keine). Damit kann ein
 *     späteres Speichern eines längst laufenden Plans nie eine „Plan
 *     angelegt"-Mail auslösen — auch nicht, wenn das Flag aus einem
 *     Deploy-Fenster (Migration vor App, alter Code legt Tranchen an) NULL
 *     geblieben ist.
 *   • Die gespeicherten Tranchen ergeben zusammen 100 %. saveTranches prüft
 *     seine Einzel-Writes nicht; ein teilweise gescheitertes Speichern soll
 *     das Einmal-Flag nicht mit einer unvollständigen Mail verbrauchen.
 */
export async function notifyPlanCreatedOnce(
  supabase: AdminClient,
  args: { tripId: string; actorId: string | null; firstSetup: boolean; todayIso?: string },
): Promise<NoticeResult & { claimed: boolean }> {
  try {
    if (!args.firstSetup) return { ...EMPTY, claimed: false };
    const { data: stored, error: trErr } = await supabase
      .from("prepayment_tranches")
      .select("percent")
      .eq("trip_id", args.tripId);
    if (trErr) return { ...loadError("Tranchen", trErr.message), claimed: false };
    const percentSum = (stored ?? []).reduce((s, t) => s + Number(t.percent), 0);
    if ((stored ?? []).length === 0 || Math.abs(percentSum - 100) > 0.01) {
      if ((stored ?? []).length > 0) console.error(LOG, "Tranchen unvollständig gespeichert — keine Plan-Mail", { percentSum });
      return { ...EMPTY, claimed: false };
    }

    const { data: claimed, error: claimErr } = await supabase
      .from("prepayment_plan")
      .update({ crew_notified_at: new Date().toISOString() })
      .eq("trip_id", args.tripId)
      .is("crew_notified_at", null)
      .select("trip_id");
    if (claimErr) {
      console.error(LOG, "Claim crew_notified_at:", claimErr.message);
      return { ...EMPTY, claimed: false, error: "Benachrichtigung nicht möglich." };
    }
    if (!claimed || claimed.length === 0) return { ...EMPTY, claimed: false };

    const res = await sendPlanAnnouncement(supabase, { tripId: args.tripId, actorId: args.actorId, isUpdate: false, todayIso: args.todayIso });
    return { ...res, claimed: true };
  } catch (err) {
    console.error(LOG, "plan-created:", err instanceof Error ? err.message : String(err));
    return { ...EMPTY, claimed: false, error: "Benachrichtigung fehlgeschlagen." };
  }
}

export async function sendPlanAnnouncement(
  supabase: AdminClient,
  args: { tripId: string; actorId: string | null; isUpdate: boolean; todayIso?: string },
): Promise<NoticeResult> {
  try {
    const [trip, planRes, trRes, oblRes] = await Promise.all([
      loadTrip(supabase, args.tripId),
      supabase
        .from("prepayment_plan")
        .select("total_amount, advancer_person_id, wero_id")
        .eq("trip_id", args.tripId)
        .maybeSingle(),
      supabase
        .from("prepayment_tranches")
        .select("id, label, due_date, percent")
        .eq("trip_id", args.tripId)
        .order("sort_order")
        .order("due_date"),
      supabase.from("prepayment_obligations").select("person_id, total_amount").eq("trip_id", args.tripId),
    ]);
    const paidRes = await supabase
      .from("v_prepayment_payments")
      .select("tranche_id, person_id, paid_amount")
      .eq("trip_id", args.tripId);
    if (paidRes.error) return loadError("Zahlungen", paidRes.error.message);
    const paidKey = (personId: string, trancheId: string) => `${personId}|${trancheId}`;
    const paidBy = new Map<string, number>();
    for (const r of paidRes.data ?? []) {
      if (r.tranche_id) paidBy.set(paidKey(r.person_id as string, r.tranche_id as string), Number(r.paid_amount));
    }
    if (!trip.ok) return loadError("Törn", trip.message);
    if (planRes.error) return loadError("Anzahlungsplan", planRes.error.message);
    if (!planRes.data) return { ...EMPTY, error: "Kein Anzahlungsplan vorhanden." };
    if (trRes.error) return loadError("Tranchen", trRes.error.message);
    if (oblRes.error) return loadError("Sollbeträge", oblRes.error.message);
    const tranches = (trRes.data ?? []).map((t) => ({
      id: t.id as string,
      label: t.label as string,
      due: t.due_date as string,
      percent: Number(t.percent),
    }));
    if (tranches.length === 0) return { ...EMPTY, error: "Der Plan hat noch keine Tranchen." };

    const advancerId = (planRes.data.advancer_person_id as string | null) ?? trip.skipperId;
    if (!advancerId) return { ...EMPTY, error: "Keine vorstreckende Person." };
    const soll = (oblRes.data ?? []).map((o) => ({ personId: o.person_id as string, amount: Number(o.total_amount) }));
    const { crew, payeeId } = announceRecipients({ soll, payeeId: advancerId, actorId: args.actorId });
    if (crew.length === 0 && !payeeId) return { ...EMPTY };

    const people = await loadPeople(
      supabase,
      [...new Set([...soll.filter((s) => s.amount > 0.005).map((s) => s.personId), advancerId])],
      [...crew.map((c) => c.personId), ...(payeeId ? [payeeId] : [])],
    );
    if (!people.ok) return loadError("Personen", people.message);
    const advancerName = people.name.get(advancerId) ?? "die vorstreckende Person";
    const weroId = normalizeWeroId(planRes.data.wero_id as string | null);
    const appUrl = prepaymentsUrl(args.tripId);
    const crewDue = (due: string) => crewDueLabel(due, args.todayIso) ?? formatDeDate(due);

    const out: Outgoing[] = crew.map((c) => ({
      personId: c.personId,
      mail: renderPlanAnnounceCrewMail({
        isUpdate: args.isUpdate,
        recipientName: people.name.get(c.personId) ?? "",
        advancerName,
        tripName: trip.name,
        tripType: trip.tripType,
        total: c.amount,
        tranches: tranches.map((t) => ({
          label: t.label,
          amount: trancheShare(c.amount, t.percent),
          paid: paidBy.get(paidKey(c.personId, t.id)) ?? 0,
          crewDue: crewDue(t.due),
        })),
        weroId,
        appUrl,
      }),
      push: planAnnouncedPush({ isUpdate: args.isUpdate, amount: c.amount, tripName: trip.name, tripId: args.tripId }),
    }));
    if (payeeId) {
      const providerTotal = Number(planRes.data.total_amount ?? 0);
      const crewSoll = soll.filter((s) => s.personId !== payeeId).reduce((s, o) => s + o.amount, 0);
      const rows = soll
        .filter((s) => s.personId !== payeeId && s.amount > 0.005)
        .map((s) => ({ name: people.name.get(s.personId) ?? "", amount: round2(s.amount) }))
        .sort((a, b) => a.name.localeCompare(b.name, "de"));
      out.push({
        personId: payeeId,
        mail: renderPlanAnnounceAdvancerMail({
          isUpdate: args.isUpdate,
          recipientName: advancerName,
          tripName: trip.name,
          tripType: trip.tripType,
          providerTotal,
          tranches: tranches.map((t) => ({
            label: t.label,
            charterDue: formatDeDate(t.due),
            toProvider: trancheShare(providerTotal, t.percent),
            fromCrew: trancheShare(crewSoll, t.percent),
          })),
          rows,
          ownAmount: round2(soll.find((s) => s.personId === payeeId)?.amount ?? 0),
          appUrl,
        }),
        push: planAnnouncedPush({ isUpdate: args.isUpdate, amount: null, tripName: trip.name, tripId: args.tripId }),
      });
    }

    const result = await deliver(supabase, people.email, out, args.isUpdate ? "plan-update" : "plan-created");
    if (result.sent > 0) {
      const { error } = await supabase
        .from("prepayment_plan")
        .update({ crew_last_notified_at: new Date().toISOString() })
        .eq("trip_id", args.tripId);
      if (error) console.error(LOG, "crew_last_notified_at (Plan):", error.message);
    }
    return result;
  } catch (err) {
    console.error(LOG, "plan-announce:", err instanceof Error ? err.message : String(err));
    return { ...EMPTY, error: "Benachrichtigung fehlgeschlagen." };
  }
}
