/**
 * Versand der Selbstmeldungs-Notification an den Skipper.
 * Spec: docs/prepayments.md §Phase 2.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { sendMail } from "@/lib/email/send";
import { renderPaymentPendingMail } from "@/lib/email/payment-pending-template";
import { formatDeDate } from "@/lib/prepayments/dates";
import { appOrigin } from "@/lib/auth/origin";

const SITE_URL = appOrigin();

export async function sendPaymentPendingMail(params: {
  tripId: string;
  transactionId: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const supabase = createAdminClient();

  const { data: tx } = await supabase
    .from("transactions")
    .select(`
      amount, description, tranche_id, credit_from,
      reporter:persons!transactions_credit_from_fkey(display_name),
      tranche:prepayment_tranches(label, due_date)
    `)
    .eq("id", params.transactionId)
    .maybeSingle();
  if (!tx) return { ok: false, message: "Buchung nicht gefunden." };

  // Trip + Plan (für Empfänger-E-Mail)
  const [{ data: trip }, { data: plan }] = await Promise.all([
    supabase.from("trips").select("name, skipper_id, trip_type").eq("id", params.tripId).maybeSingle(),
    supabase.from("prepayment_plan").select("advancer_person_id").eq("trip_id", params.tripId).maybeSingle(),
  ]);
  if (!trip) return { ok: false, message: "Törn nicht gefunden." };
  const advancerId = plan?.advancer_person_id || trip.skipper_id;

  const [{ data: advancer }, { data: advancerPriv }] = await Promise.all([
    supabase.from("persons").select("display_name").eq("id", advancerId).maybeSingle(),
    supabase.from("persons_private").select("email").eq("person_id", advancerId).maybeSingle(),
  ]);
  if (!advancerPriv?.email) {
    return { ok: false, message: "Für die vorstreckende Person ist keine E-Mail-Adresse hinterlegt." };
  }

  const reporterRel = (tx as unknown as { reporter: { display_name: string } | { display_name: string }[] }).reporter;
  const reporterFlat = Array.isArray(reporterRel) ? reporterRel[0] : reporterRel;
  const trancheRel = (tx as unknown as { tranche: { label: string; due_date: string } | { label: string; due_date: string }[] }).tranche;
  const trancheFlat = Array.isArray(trancheRel) ? trancheRel[0] : trancheRel;

  const mail = renderPaymentPendingMail({
    skipperName: advancer?.display_name ?? "Skipper",
    reporterName: reporterFlat?.display_name ?? "Crewmitglied",
    tripName: trip.name,
    trancheLabel: trancheFlat?.label ?? "Anzahlung",
    trancheDueDate: trancheFlat?.due_date ? formatDeDate(trancheFlat.due_date) : "",
    amount: Number(tx.amount),
    note: tx.description,
    appUrl: `${SITE_URL}/trips/${params.tripId}/prepayments`,
    tripType: trip.trip_type === "other" ? "other" : "sailing",
  });

  const result = await sendMail({
    to: advancerPriv.email,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
  return result.ok ? { ok: true } : { ok: false, message: result.error };
}

