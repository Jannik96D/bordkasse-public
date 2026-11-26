"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { requireMember, requireSkipperOrAdmin } from "@/lib/auth/authz";
import { logAudit } from "@/lib/db/audit";
import { getBalances, getBordkasseOnlyBalances, getSimplifiedDebts } from "@/lib/queries/balances";
import { splitMailBalances } from "@/lib/calc/settlement-balances";
import { sendMails, type MailMessage } from "@/lib/email/send";
import { renderSettlementMail, type DebtItem } from "@/lib/email/settlement-template";
import { sendPushToPersons } from "@/lib/notify/web-push";
import { pushRecipients } from "@/lib/notify/recipients";
import { settlementAnnouncedPush, settlementUpdatedPush } from "@/lib/notify/payloads";
import { formatDate } from "@/lib/utils";
import { appOrigin } from "@/lib/auth/origin";
import { markBalancesMayHaveChanged } from "@/lib/db/settlement-marker";

/**
 * Versand-Sperre (Slice 9, Sicherheitsrunde 2026-11). announce/resend
 * claimen den Versand atomar VOR dem Mailversand, damit ein Doppelklick
 * (zwei parallele Requests) die Mails nicht zweimal verschickt. Ohne eigene
 * Spalte (keine Migration) dient ein Zeitstempel als befristete Sperre:
 * bricht ein Request zwischen Claim und Versand ab (Container-Neustart beim
 * Auto-Deploy, Wurf im Mailer), läuft die Sperre nach SEND_LEASE_MS aus und
 * der Versand bleibt wiederholbar — statt für immer „schon verschickt" zu
 * gelten.
 *
 *  • Erstversand (announce / Retry nach komplettem Fehlschlag, 0052):
 *    `settlement_announced_at` = Claim-Zeit; ein Retry ist nur erlaubt,
 *    solange `settlement_mail_sent_at IS NULL` und `settlement_announced_at`
 *    älter als die Sperre ist.
 *  • Update-Mail: `changes_pending_since` wird auf Claim-Zeit + Sperre in die
 *    ZUKUNFT gesetzt. Der Marker bleibt dadurch gesetzt (Banner bleibt,
 *    crash-sicher), ein zweiter Request sieht einen Zukunfts-Wert und darf
 *    nicht claimen. Echte Marker setzt die DB mit NOW() — immer ≤ jetzt.
 */
const SEND_LEASE_MS = 10 * 60 * 1000;
/** Toleranz für Uhrabweichung App ↔ DB beim Erkennen echter Marker. */
const CLOCK_SKEW_MS = 60 * 1000;
/**
 * Slice 10: Mindestabstand zwischen zwei Update-Mails. Der Marker
 * `changes_pending_since` lässt sich durch „Buchung anlegen + löschen"
 * beliebig oft neu setzen; ohne Abstand könnte ein Crewmitglied so die
 * ganze Crew mit Update-Mails fluten. Gilt NICHT für den Retry eines
 * komplett gescheiterten Erstversands (dort ist noch keine Mail raus).
 */
export const RESEND_MIN_INTERVAL_MS = 60 * 60 * 1000;
const isoShift = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

/**
 * Knappe SMTP-Timeouts für die Abrechnungs-Mails (Grill zu PR #311): mit den
 * nodemailer-Defaults (Socket 10 min) könnte ein hängender Mailserver die
 * Versand-Sperre überdauern — dann dürfte ein zweiter Request claimen und
 * dieselben Mails noch einmal schicken. Bei ≤ 12 Empfängern über 5 gepoolte
 * Verbindungen bleibt der Versand so sicher unter SEND_LEASE_MS.
 */
const SETTLEMENT_MAIL_TIMEOUTS = { connectionTimeoutMs: 15_000, greetingTimeoutMs: 15_000, socketTimeoutMs: 30_000 } as const;

/**
 * Audit-Tabellen der Schreibpfade, die `mark_post_settlement_change` rufen
 * (Buchungen, Crew/Anwesenheit/Trinker-Flag, Posten-Soll). Während einer
 * laufenden Update-Mail ist der Marker auf einen Zukunftswert gesetzt — die
 * RPC ist dann ein No-op. Nach dem Abschluss wird deshalb im Audit-Log
 * nachgesehen, ob in diesem Fenster etwas passiert ist (siehe
 * `remarkIfChangedDuringSend`).
 */
const BALANCE_AUDIT_TABLES = ["transactions", "trip_members", "prepayment_item_obligations"];

/**
 * Referenzpunkt VOR dem Lesen der Bilanz: der jüngste saldorelevante
 * Audit-Eintrag des Törns (DB-Uhr). Alles bis hierhin steckt sicher in der
 * Mail. Bewusst NICHT „App-Uhr minus Toleranz" (Delta-Grill zu PR #311):
 * eine Buchung, die der Nutzer Sekunden vor „Update-Mail verschicken"
 * erfasst hat, zählte sonst als „während des Versands" → der Banner käme
 * sofort wieder, ein zweiter Klick verschickte eine zweite Mail.
 * `null` = noch kein Eintrag; `"error"` = nicht lesbar.
 */
async function latestBalanceAuditAt(
  supabase: ReturnType<typeof createAdminClient>,
  tripId: string,
): Promise<string | null | "error"> {
  const { data, error } = await supabase
    .from("audit_log")
    .select("created_at")
    .eq("trip_id", tripId)
    .in("table_name", BALANCE_AUDIT_TABLES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[bordkasse:db] resend audit reference:", error.message);
    return "error";
  }
  return (data as { created_at?: string } | null)?.created_at ?? null;
}

/**
 * Gibt es saldorelevante Audit-Einträge, die NEUER als der vor dem Lesen
 * der Bilanz gemerkte Referenzpunkt sind, Marker erneut setzen. Fail-safe:
 * bei einem Lesefehler (auch des Referenzpunkts) ebenfalls setzen — ein
 * überflüssiger Banner ist harmlos, ein fehlender entwertet Häkchen.
 */
async function remarkIfChangedDuringSend(
  supabase: ReturnType<typeof createAdminClient>,
  tripId: string,
  reference: string | null | "error",
): Promise<void> {
  if (reference === "error") {
    await markBalancesMayHaveChanged(supabase, tripId);
    return;
  }
  let query = supabase
    .from("audit_log")
    .select("id", { count: "exact", head: true })
    .eq("trip_id", tripId)
    .in("table_name", BALANCE_AUDIT_TABLES);
  if (reference !== null) query = query.gt("created_at", reference);
  const { count, error } = await query;
  if (error) console.error("[bordkasse:db] resend recheck:", error.message);
  if (error || (count ?? 0) > 0) await markBalancesMayHaveChanged(supabase, tripId);
}

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
 *
 * BEWUSST NICHT durch `assertTripNotArchived` (Sanierungsplan D3) geschützt
 * — weder hier noch in `resendSettlement`: ein Törn wird typischerweise
 * NACH Törnende archiviert, genau dann, wenn die Abrechnung erst verschickt
 * werden soll. Ein Schreibschutz würde das Kernfeature blockieren, das den
 * Törn überhaupt abschließt.
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

  // Slice 9: atomarer Claim VOR allem anderen. Vorher wurde das GATE erst
  // NACH dem Versand gesetzt — ein Doppelklick (beide Requests sehen
  // settlement_announced_at = NULL) verschickte alle Mails zweimal. Jetzt
  // gewinnt genau ein `UPDATE … WHERE settlement_announced_at IS NULL
  // RETURNING`; der zweite bekommt 0 Zeilen (Muster crew_notified_at, 0062).
  // Claim vor dem Lesen der Bilanz: eine Buchung, die währenddessen
  // entsteht, setzt so (Gate schon gesetzt) sauber den Änderungs-Marker.
  const claimedAt = new Date().toISOString();
  const { data: claimed, error: claimErr } = await supabase
    .from("trips")
    .update({ settlement_announced_at: claimedAt, settlement_announced_by: person.id })
    .eq("id", tripId)
    .is("settlement_announced_at", null)
    .select("id");
  if (claimErr) {
    console.error("[bordkasse:db]", claimErr.message);
    return { ok: false, message: "Konnte Abrechnungs-Flag nicht setzen." };
  }
  if (!claimed || claimed.length === 0) {
    return { ok: false, message: "Abrechnung wurde bereits verschickt." };
  }
  // Abbruch VOR dem Versand (Lesefehler) → Claim vollständig zurückgeben,
  // der Skipper kann es sofort erneut versuchen.
  const abortBeforeSend = async (message: string): Promise<Result> => {
    const { data: released, error } = await supabase
      .from("trips")
      .update({ settlement_announced_at: null, settlement_announced_by: null })
      .eq("id", tripId)
      .eq("settlement_announced_at", claimedAt)
      .select("id");
    if (error) console.error("[bordkasse:db] settlement release:", error.message);
    if (released && released.length > 0) {
      // Ein Marker, der erst im Claim-Fenster entstand, gehört zu dieser
      // zurückgenommenen Abrechnung — sonst erschiene beim nächsten announce
      // sofort ein unbegründeter „Bilanz geändert"-Banner. Ältere Marker
      // (vor dem Claim) bleiben unberührt.
      const { error: mErr } = await supabase
        .from("trips")
        .update({ changes_pending_since: null })
        .eq("id", tripId)
        .gte("changes_pending_since", isoShift(claimedAt, -CLOCK_SKEW_MS));
      if (mErr) console.error("[bordkasse:db] settlement release marker:", mErr.message);
    }
    return { ok: false, message };
  };

  // Aktuelle Bilanz + Schulden-Plan ziehen.
  //
  // Entscheidung M1 (PR4a-Review): der Saldo in der Mail ist der
  // BORDKASSE-Saldo — er passt damit zum Zahlungsplan (simplify_debts, nur
  // Bordkasse) und zur Bilanz-Seite. Offene Beträge aus Anzahlung/Posten
  // werden getrennt ausgewiesen (lib/calc/settlement-balances.ts). Vorher
  // stand dort die Gesamtbilanz, die mit dem Zahlungsplan nicht aufging.
  let totalBalances: Awaited<ReturnType<typeof getBalances>>;
  let kittyBalances: Awaited<ReturnType<typeof getBordkasseOnlyBalances>>;
  let debts: Awaited<ReturnType<typeof getSimplifiedDebts>>;
  try {
    [totalBalances, kittyBalances, debts] = await Promise.all([
      getBalances(tripId),
      getBordkasseOnlyBalances(tripId),
      getSimplifiedDebts(tripId),
    ]);
  } catch (e) {
    console.error("[bordkasse:settlement] balances:", e);
    return abortBeforeSend("Bilanz konnte nicht geladen werden — es wurde keine Mail verschickt. Bitte erneut versuchen.");
  }
  const mailBalances = splitMailBalances(totalBalances, kittyBalances);

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
  // Delta-Review 4: leere Bilanz trotz Crew = Lesefehler o. ä. — nie eine
  // Mail mit „Du bist quitt" an alle schicken.
  if (members.length > 0 && totalBalances.length === 0) {
    return abortBeforeSend("Bilanz ist leer, obwohl es eine Crew gibt — es wurde keine Mail verschickt.");
  }
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
  const appUrl = `${appOrigin()}/trips/${tripId}/debts`;

  let skipped = 0;

  // Erst alle personalisierten Mails aufbauen (rein in-memory), dann in EINEM
  // gepoolten Batch nebenläufig verschicken (Fund E-1) statt N sequenzieller
  // SMTP-Handshakes. `skipped` = Member ohne Mail-Adresse.
  const jobs: { personId: string; message: MailMessage }[] = [];
  for (const m of members) {
    const email = emailById.get(m.person_id);
    if (!email) {
      skipped += 1;
      continue;
    }
    const mailBalance = mailBalances.get(m.person_id);

    // Zahlungsanweisungen aus dem Schulden-Plan
    const myDebts: DebtItem[] = [];
    for (const d of debts) {
      if (d.from_person_id === m.person_id) {
        myDebts.push({ counterparty_name: d.to_name, amount: d.amount, direction: "owes" });
      } else if (d.to_person_id === m.person_id) {
        myDebts.push({ counterparty_name: d.from_name, amount: d.amount, direction: "receives" });
      }
    }

    const { html, text, subject } = renderSettlementMail({
      recipientName: displayName(m),
      tripName: trip.name,
      tripDates,
      balance: mailBalance?.kitty ?? 0,
      poolBalance: mailBalance?.pool ?? 0,
      debts: myDebts,
      appUrl,
      skipperName,
      tripType,
    });
    jobs.push({ personId: m.person_id, message: { to: email, subject, html, text } });
  }

  const results = await sendMails(jobs.map((j) => j.message), SETTLEMENT_MAIL_TIMEOUTS);
  let sent = 0;
  let failed = 0;
  results.forEach((res, i) => {
    if (res.ok) sent += 1;
    else {
      failed += 1;
      // PII (Mail-Adresse) bewusst NICHT loggen — Person-ID reicht für Diagnose.
      console.error("[bordkasse:settlement] mail failed", { person_id: jobs[i].personId, error: res.error });
    }
  });

  // Das GATE (settlement_announced_at: Häkchen, Purge-Blocker, Checkliste)
  // bleibt gesetzt, auch wenn alle Mails scheitern. settlement_mail_sent_at
  // (0052) nur bei mindestens einer zugestellten Mail — sonst bleibt der
  // Erstversand über resendSettlement wiederholbar (Fund 2, PR 6).
  if (sent > 0) {
    const { error } = await supabase
      .from("trips")
      .update({ settlement_mail_sent_at: new Date().toISOString() })
      .eq("id", tripId);
    // Nur geloggt: die Mails sind raus. Folge wäre ein Retry-Knopf, der erst
    // nach Ablauf der Versand-Sperre greift.
    if (error) console.error("[bordkasse:db] settlement mail_sent_at:", error.message);
  } else {
    // Nichts zugestellt → Versand-Sperre sofort aufheben (Gate vordatieren),
    // damit der Retry nicht erst nach SEND_LEASE_MS möglich ist.
    const { error } = await supabase
      .from("trips")
      .update({ settlement_announced_at: isoShift(claimedAt, -SEND_LEASE_MS - 1000) })
      .eq("id", tripId)
      .eq("settlement_announced_at", claimedAt);
    if (error) console.error("[bordkasse:db] settlement release:", error.message);
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
  // wir nicht — er hat die Abrechnung gerade ausgelöst. Kam keine Mail an,
  // auch kein Push „Abrechnung verschickt" (Slice 9).
  if (sent > 0) {
    await sendPushToPersons(
      supabase,
      pushRecipients(members.map((m) => m.person_id), { excludeActorId: person.id }),
      settlementAnnouncedPush(trip.name, tripId),
    );
  }

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
  // direkt selbst raushauen, ohne den Skipper bemühen zu müssen. Der Resend
  // funktioniert nur, wenn `changes_pending_since` gesetzt ist (Guard unten,
  // Fund 8 Code-Review 2026-08). Das allein schließt Spam NICHT aus: jede
  // Buchungs-Änderung setzt den Marker neu, „anlegen + löschen" also
  // beliebig oft. Deshalb zusätzlich ein Mindestabstand von 1 h zwischen
  // zwei Update-Mails (`RESEND_MIN_INTERVAL_MS`, Slice 10).
  const auth = await requireMember(tripId);
  if (!auth.ok) return { ok: false, message: auth.message };

  const supabase = createAdminClient();

  const { data: trip } = await supabase
    .from("trips")
    .select(
      "id, name, start_date, end_date, settlement_announced_at, settlement_mail_sent_at, changes_pending_since, last_settlement_resend_at, trip_type",
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
  // Noch nie erfolgreich zugestellt (kompletter Erstversand-Fehlschlag,
  // Fund 2 PR 6)? Dann darf erneut versucht werden, auch OHNE
  // changes_pending_since — sonst gäbe es aus diesem Zustand keinen Ausweg,
  // die Crew hätte nie erfahren, dass die Abrechnung existiert. Wurde
  // dagegen bereits mindestens einmal erfolgreich zugestellt, bleibt der
  // ursprüngliche Spam-Schutz (Fund 8, Code-Review 2026-08) unverändert.
  const neverSuccessfullySent = !trip.settlement_mail_sent_at;
  if (!neverSuccessfullySent && !trip.changes_pending_since) {
    return {
      ok: false,
      message: "Seit der letzten Abrechnungs-Mail hat sich nichts geändert.",
    };
  }

  // Slice 10: Mindestabstand zur letzten Update-Mail (nicht beim Retry eines
  // gescheiterten Erstversands). Der Marker bleibt gesetzt, der Banner
  // bleibt sichtbar — die Mail geht später raus.
  if (!neverSuccessfullySent && trip.last_settlement_resend_at) {
    const sinceLast = Date.now() - Date.parse(trip.last_settlement_resend_at);
    if (sinceLast >= 0 && sinceLast < RESEND_MIN_INTERVAL_MS) {
      const mins = Math.max(1, Math.ceil((RESEND_MIN_INTERVAL_MS - sinceLast) / 60000));
      return {
        ok: false,
        message: `Die letzte Update-Mail ist erst kurz her. Bitte in etwa ${mins} Min. erneut versuchen — die Änderungen gehen dann gesammelt raus.`,
      };
    }
  }

  // Slice 9: atomarer Claim VOR dem Versand (Versand-Sperre, siehe
  // SEND_LEASE_MS oben). Vorher wurde der Marker erst NACH dem Versand
  // gelöscht — ein Doppelklick verschickte die Mail zweimal.
  const claimedAt = new Date().toISOString();
  const leaseUntil = isoShift(claimedAt, SEND_LEASE_MS);
  const { data: claimed, error: claimErr } = neverSuccessfullySent
    ? // Erstversand-Retry: nur, wenn kein Erstversand gerade läuft (announce
      // setzt settlement_announced_at beim Claim auf „jetzt").
      await supabase
        .from("trips")
        .update({ settlement_announced_at: claimedAt })
        .eq("id", tripId)
        .is("settlement_mail_sent_at", null)
        .lt("settlement_announced_at", isoShift(claimedAt, -SEND_LEASE_MS))
        .select("id")
    : // Update-Mail: echter Marker (≤ jetzt) → in die Zukunft verschieben.
      await supabase
        .from("trips")
        .update({ changes_pending_since: leaseUntil })
        .eq("id", tripId)
        .lte("changes_pending_since", isoShift(claimedAt, CLOCK_SKEW_MS))
        .select("id");
  if (claimErr) {
    console.error("[bordkasse:db]", claimErr.message);
    return { ok: false, message: "Konnte Resend-Marker nicht aktualisieren." };
  }
  if (!claimed || claimed.length === 0) {
    return {
      ok: false,
      message: neverSuccessfullySent
        ? "Die Abrechnung wird gerade verschickt. Bitte in ein paar Minuten erneut versuchen."
        : "Die Update-Mail wird gerade verschickt oder wurde schon verschickt. Bitte Seite neu laden.",
    };
  }
  // Claim zurückgeben (Lesefehler vor dem Versand oder keine Mail
  // zugestellt): ursprünglichen Zustand wiederherstellen — nur, solange
  // noch UNSER Claim drinsteht.
  const releaseClaim = async (): Promise<void> => {
    const { error } = neverSuccessfullySent
      ? await supabase
          .from("trips")
          .update({ settlement_announced_at: trip.settlement_announced_at })
          .eq("id", tripId)
          .eq("settlement_announced_at", claimedAt)
      : await supabase
          .from("trips")
          .update({ changes_pending_since: trip.changes_pending_since })
          .eq("id", tripId)
          .eq("changes_pending_since", leaseUntil);
    if (error) console.error("[bordkasse:db] resend release:", error.message);
  };
  // Referenzpunkt für den Nachcheck nach dem Versand (beide Pfade) — direkt
  // nach dem Claim und VOR dem Lesen der Bilanz.
  const auditReference = await latestBalanceAuditAt(supabase, tripId);

  // Diff-Hinweis aus dem Audit-Log: alle Transaktions-Änderungen seit dem
  // Marker (oder seit dem letzten Resend / der initialen Abrechnung). Ist
  // der Erstversand noch nie erfolgreich zugestellt worden, ist das hier
  // gar kein "Update" — es ist der erste tatsächliche Versand, ein Diff
  // ergibt dann keinen Sinn.
  let changeSummary: string | undefined;
  if (!neverSuccessfullySent) {
    const since =
      trip.changes_pending_since ??
      trip.last_settlement_resend_at ??
      trip.settlement_announced_at;
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
  }

  let totalBalances: Awaited<ReturnType<typeof getBalances>>;
  let kittyBalances: Awaited<ReturnType<typeof getBordkasseOnlyBalances>>;
  let debts: Awaited<ReturnType<typeof getSimplifiedDebts>>;
  try {
    [totalBalances, kittyBalances, debts] = await Promise.all([
      getBalances(tripId),
      getBordkasseOnlyBalances(tripId),
      getSimplifiedDebts(tripId),
    ]);
  } catch (e) {
    console.error("[bordkasse:settlement] balances:", e);
    await releaseClaim();
    return { ok: false, message: "Bilanz konnte nicht geladen werden — es wurde keine Mail verschickt. Bitte erneut versuchen." };
  }
  const mailBalances = splitMailBalances(totalBalances, kittyBalances);

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
  // Delta-Review 4: leere Bilanz trotz Crew = Lesefehler o. ä. — nie eine
  // Mail mit „Du bist quitt" an alle schicken.
  if (members.length > 0 && totalBalances.length === 0) {
    await releaseClaim();
    return { ok: false, message: "Bilanz ist leer, obwohl es eine Crew gibt — es wurde keine Mail verschickt." };
  }
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
  const appUrl = `${appOrigin()}/trips/${tripId}/debts`;

  let skipped = 0;

  // Wie announce (Fund E-1): personalisierte Mails sammeln, dann in EINEM
  // gepoolten Batch nebenläufig verschicken.
  const jobs: { personId: string; message: MailMessage }[] = [];
  for (const m of members) {
    const email = emailById.get(m.person_id);
    if (!email) {
      skipped += 1;
      continue;
    }
    const mailBalance = mailBalances.get(m.person_id);

    const myDebts: DebtItem[] = [];
    for (const d of debts) {
      if (d.from_person_id === m.person_id) {
        myDebts.push({ counterparty_name: d.to_name, amount: d.amount, direction: "owes" });
      } else if (d.to_person_id === m.person_id) {
        myDebts.push({ counterparty_name: d.from_name, amount: d.amount, direction: "receives" });
      }
    }

    const { html, text, subject } = renderSettlementMail({
      recipientName: displayName(m),
      tripName: trip.name,
      tripDates,
      balance: mailBalance?.kitty ?? 0,
      poolBalance: mailBalance?.pool ?? 0,
      debts: myDebts,
      appUrl,
      skipperName,
      // War der Erstversand nie erfolgreich, ist das hier de facto die
      // erste echte Abrechnungs-Mail — kein "Update" (kein "Bilanz
      // aktualisiert"-Wortlaut, kein Diff).
      isUpdate: !neverSuccessfullySent,
      changeSummary,
      tripType,
    });
    jobs.push({ personId: m.person_id, message: { to: email, subject, html, text } });
  }

  const results = await sendMails(jobs.map((j) => j.message), SETTLEMENT_MAIL_TIMEOUTS);
  let sent = 0;
  let failed = 0;
  results.forEach((res, i) => {
    if (res.ok) sent += 1;
    else {
      failed += 1;
      console.error("[bordkasse:settlement-resend] mail failed", { person_id: jobs[i].personId, error: res.error });
    }
  });

  if (sent > 0) {
    // Erfolg → Claim abschließen. Die Mails sind raus; ein Schreibfehler hier
    // wird nur geloggt (Folge: der Banner bleibt bzw. der Retry greift nach
    // Ablauf der Versand-Sperre erneut).
    const nowIso = new Date().toISOString();
    if (neverSuccessfullySent) {
      // Gate zurück auf den ursprünglichen Zeitpunkt (der Claim hatte es auf
      // „jetzt" gesetzt), Erstversand als zugestellt markieren.
      const { error } = await supabase
        .from("trips")
        .update({
          settlement_announced_at: trip.settlement_announced_at,
          settlement_mail_sent_at: nowIso,
          last_settlement_resend_at: nowIso,
        })
        .eq("id", tripId)
        .eq("settlement_announced_at", claimedAt);
      if (error) console.error("[bordkasse:db] resend finish:", error.message);
      if (trip.changes_pending_since) {
        // Ein schon vorher offener Marker ist mit dieser Mail erledigt; ein
        // währenddessen NEU gesetzter (anderer Zeitstempel) bleibt stehen.
        const { error: mErr } = await supabase
          .from("trips")
          .update({ changes_pending_since: null })
          .eq("id", tripId)
          .eq("changes_pending_since", trip.changes_pending_since);
        if (mErr) console.error("[bordkasse:db] resend finish marker:", mErr.message);
      }
    } else {
      const { error } = await supabase
        .from("trips")
        .update({ changes_pending_since: null, last_settlement_resend_at: nowIso })
        .eq("id", tripId)
        .eq("changes_pending_since", leaseUntil);
      if (error) console.error("[bordkasse:db] resend finish:", error.message);
    }
    // Beide Pfade: eine Saldo-Änderung, die während des Versands entstand,
    // konnte den Marker nicht setzen (Update-Pfad: Marker stand auf dem
    // Zukunftswert; Erstversand mit offenem Marker: Marker war schon
    // gesetzt) und wurde mit dem Abschluss eben mit gelöscht → nachholen.
    await remarkIfChangedDuringSend(supabase, tripId, auditReference);
  } else {
    // Nichts zugestellt → Claim zurückgeben, damit der Versand sofort
    // erneut versucht werden kann.
    await releaseClaim();
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
  if (sent > 0) {
    await sendPushToPersons(
      supabase,
      pushRecipients(members.map((m) => m.person_id), { excludeActorId: person.id }),
      settlementUpdatedPush(trip.name, tripId),
    );
  }

  revalidatePath(`/trips/${tripId}`);
  revalidatePath(`/trips/${tripId}/balance`);
  revalidatePath(`/trips/${tripId}/debts`);
  return { ok: true, sent, skipped, failed };
}
