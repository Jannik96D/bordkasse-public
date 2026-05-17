"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdmin, requireMember } from "@/lib/auth/authz";
import { logAudit } from "@/lib/db/audit";

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
