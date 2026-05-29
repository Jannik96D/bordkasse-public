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
 * Schickt nach einem positiven Bezahlt-Toggle die Mails:
 *   - an den Schuldner (Bestätigung „Du hast abgehakt")
 *   - an den Gläubiger (Hinweis „X hat seine Zahlung abgehakt")
 *   - bei Admin-/Dritt-Aktion zusätzlich an Skipper und Vorstrecker, sofern
 *     sie nicht ohnehin Schuldner oder Gläubiger sind — sie müssen wissen,
 *     dass jemand anders in ihrem Trip-Kontext geklickt hat.
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
): Promise<void> {
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
  if (!trip) return;

  const advancerPersonId = plan?.advancer_person_id ?? trip.skipper_id;

  const actorRole: "debtor" | "creditor" | "other" =
    args.actorPersonId === args.fromPersonId
      ? "debtor"
      : args.actorPersonId === args.toPersonId
        ? "creditor"
        : "other";

  // Empfänger-Liste: immer Schuldner + Gläubiger. Bei "other"-Actor zusätzlich
  // Skipper und Vorstrecker, sofern sie nicht ohnehin schon drin sind.
  const recipients: Array<{ personId: string; role: "debtor" | "creditor" }> = [
    { personId: args.fromPersonId, role: "debtor" },
    { personId: args.toPersonId, role: "creditor" },
  ];
  if (actorRole === "other") {
    const co = new Set([trip.skipper_id, advancerPersonId]);
    co.delete(args.fromPersonId);
    co.delete(args.toPersonId);
    co.delete(args.actorPersonId); // dem Actor selbst keine "Info"-Kopie
    for (const personId of co) {
      // Skipper/Vorstrecker bekommen den Wortlaut "X hat eine Schuld
      // zwischen A und B abgehakt" — wir kodieren das als "creditor"-Rolle
      // mit unverändertem Schuldner-/Gläubiger-Namen, sodass das Template
      // die "Zahlung von A an dich"-Variante nicht ausspielt. Saubererer
      // Weg: eigene Rolle "observer". Vorerst Pragmatik — wir nehmen die
      // existierende creditor-Variante mit actorRole=other; Wortlaut passt
      // ("X hat markiert, dass die Zahlung von A in Höhe von Y an dich
      // erledigt ist") wäre für Observer falsch. Lieber: eigene Notice-Mail
      // mit neutralem Wortlaut. → wir senden hier einen NEUTRALEN Hinweis
      // über die Notice-Variante (siehe unten).
      recipients.push({ personId, role: "observer" as unknown as "creditor" });
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

  const debtorName = nameById.get(args.fromPersonId) ?? "Schuldner";
  const creditorName = nameById.get(args.toPersonId) ?? "Gläubiger";
  const actorName = nameById.get(args.actorPersonId) ?? "Skipper";
  const tripDates = `${formatDate(trip.start_date)} – ${formatDate(trip.end_date)}`;
  const appUrl = `${process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://bordkasse.example"}/trips/${args.tripId}/debts`;

  // Dedup: pro Person-ID nur EINE Mail (falls jemand sowohl Skipper als
  // auch Vorstrecker und gleichzeitig Schuldner ist → erste Rolle gewinnt).
  const seen = new Set<string>();

  for (const r of recipients) {
    if (seen.has(r.personId)) continue;
    seen.add(r.personId);
    const email = emailById.get(r.personId);
    if (!email) continue;

    const recipientName = nameById.get(r.personId) ?? "Crew-Mitglied";

    // Observer-Pfad: neutraler Wortlaut „X hat zwischen A und B abgehakt".
    // Wir nutzen die bestehende `actorRole=other` Logik mit eigener
    // Empfänger-Rolle; aktueller Template-Wortlaut für recipient=creditor
    // + actor=other ist „X hat markiert, dass die Zahlung von A in Höhe
    // von Y an DICH erledigt ist" — das wäre für einen Observer falsch.
    // Pragmatischer Fix: für Observer setzen wir recipientName auf den
    // Beobachter, aber recipientRole=debtor — der Wortlaut ist dann
    // „X hat markiert, dass deine Zahlung an Y erledigt ist", was für den
    // Observer ebenfalls irreführend wäre.
    // → Wir umschiffen das, indem wir einen expliziten Observer-Branch
    // mit minimalem Custom-Wortlaut bauen.
    if ((r as { role: string }).role === "observer") {
      const observerSubject = `Schuld abgehakt: ${debtorName} → ${creditorName} (Trip ${trip.name})`;
      const html = renderObserverHtml({
        recipientName,
        actorName,
        debtorName,
        creditorName,
        amount: args.amount,
        tripName: trip.name,
        appUrl,
      });
      const text = renderObserverText({
        recipientName,
        actorName,
        debtorName,
        creditorName,
        amount: args.amount,
        tripName: trip.name,
        appUrl,
      });
      const res = await sendMail({ to: email, subject: observerSubject, html, text });
      if (!res.ok) {
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
    if (!res.ok) {
      // PII (Mail-Adresse) bewusst NICHT loggen.
      console.error("[bordkasse:debt-settled-mail] failed", { person_id: r.personId, error: res.error });
    }
  }
}

/**
 * Neutraler "Observer"-Mailtext für Skipper/Vorstrecker, wenn ein Admin
 * eine Schuld zwischen zwei anderen abgehakt hat — sie bekommen eine
 * reine Info, keine Bestätigung in ihrem eigenen Namen.
 *
 * Wir bauen das Template inline (kleines Snippet), damit nicht extra ein
 * weiteres Renderer-Modul nötig ist. Layout via mail-shell.
 */
function renderObserverHtml(p: {
  recipientName: string;
  actorName: string;
  debtorName: string;
  creditorName: string;
  amount: number;
  tripName: string;
  appUrl: string;
}): string {
  const fmt = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
  const amount = fmt.format(p.amount);
  const lines = `Hi ${escapeForMail(p.recipientName)},

${escapeForMail(p.actorName)} hat soeben in der Bordkasse markiert, dass die Zahlung von ${escapeForMail(p.debtorName)} in Höhe von ${amount} an ${escapeForMail(p.creditorName)} erledigt ist.

Du bekommst diese Info-Mail, weil du Skipper oder Vorstrecker dieses Törns bist — falls etwas nicht stimmt, kann das Häkchen in der App wieder entfernt werden.`;

  // Bauen wir mit der mail-shell, aber inline statt extra Datei.
  // Wir importieren den Shell, weil wir das nicht doppelt definieren wollen.
  // (Statt require: dynamischer Import wäre overkill — TS resolved direkt.)
  return `<!DOCTYPE html>
<html lang="de"><body style="margin:0;padding:24px;background:#FAFBFC;font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#1A2533;">
  <div style="max-width:560px;margin:0 auto;background:#FFFFFF;border:1px solid #D6E1EE;border-radius:12px;padding:24px;">
    <h2 style="margin:0 0 12px;color:#1D4281;font-size:18px;">Schuld in deinem Trip abgehakt</h2>
    <p style="margin:0 0 8px;color:#587EA8;font-size:13px;">${escapeForMail(p.tripName)}</p>
    <p style="white-space:pre-line;line-height:1.55;font-size:15px;">${lines}</p>
    <p style="margin-top:18px;"><a href="${p.appUrl}" style="display:inline-block;padding:10px 18px;background:#114884;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;">Schulden in der App ansehen</a></p>
  </div>
</body></html>`;
}

function renderObserverText(p: {
  recipientName: string;
  actorName: string;
  debtorName: string;
  creditorName: string;
  amount: number;
  tripName: string;
  appUrl: string;
}): string {
  const fmt = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
  return `Schuld in deinem Trip abgehakt
${p.tripName}

Hi ${p.recipientName},

${p.actorName} hat soeben in der Bordkasse markiert, dass die Zahlung von ${p.debtorName} in Höhe von ${fmt.format(p.amount)} an ${p.creditorName} erledigt ist.

Du bekommst diese Info-Mail, weil du Skipper oder Vorstrecker dieses Törns bist — falls etwas nicht stimmt, kann das Häkchen in der App wieder entfernt werden.

In der App: ${p.appUrl}
`;
}

function escapeForMail(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" :
    ch === "<" ? "&lt;" :
    ch === ">" ? "&gt;" :
    ch === '"' ? "&quot;" : "&#39;",
  );
}
