import { z } from "zod";
import type { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * „Einzahlung erfassen" bei offener Selbstmeldung (Bugfix Doppelzahlung):
 * Meldung und Erfassung sind zwei getrennte Gutschriften. Erfasst der Skipper
 * die Zahlung, statt die Meldung im Banner zu bestätigen, blieb die Meldung
 * offen — ein späteres „Bestätigen" buchte dasselbe Geld ein zweites Mal.
 *
 * Der Dialog schickt deshalb die IDs der Meldungen mit, die er angezeigt hat
 * (Haken „Gemeldete Zahlung damit erledigt", Standard an). Bewusst die
 * angezeigten IDs statt „alle offenen dieser Person": eine Meldung, die erst
 * nach dem Öffnen des Dialogs eingeht, hat der Skipper nie gesehen und darf
 * nicht still verschwinden.
 *
 * Die Meldung wird soft-gelöscht (wie `rejectSelfPayment`), aber OHNE
 * Ablehnungs-Mail — sie ist ja nicht abgelehnt, sondern durch die Erfassung
 * ersetzt; die Person bekommt die normale „erfasst"-Benachrichtigung.
 */
export const ResolvePendingIds = z.array(z.string().uuid("Ungültige Auswahl.")).max(20);

export function readResolvePendingIds(formData: FormData): unknown {
  return formData.getAll("resolve_pending_ids").filter((v) => typeof v === "string" && v !== "");
}

export async function resolvePendingReports(
  supabase: AdminClient,
  args: {
    tripId: string;
    personId: string;
    /**
     * `plan`: jede Rate des Anzahlungsplans — die Crew meldet evtl. auf Rate 1,
     * der Skipper erfasst auf Rate 2 (oder per Überschuss-Umbuchung); auch
     * dann muss die angezeigte Meldung erledigt werden, sonst bucht ein
     * späteres Bestätigen wieder doppelt.
     */
    pool: { plan: true } | { itemId: string };
    ids: string[];
  },
): Promise<{ resolved: string[]; error: string | null }> {
  if (args.ids.length === 0) return { resolved: [], error: null };
  let q = supabase
    .from("transactions")
    .update({ deleted_at: new Date().toISOString() })
    .in("id", args.ids)
    .eq("trip_id", args.tripId)
    .eq("type", "credit")
    .eq("credit_from", args.personId)
    // Nur echte, noch offene Meldungen — eine bestätigte Zahlung darf hierüber
    // nie verschwinden (sonst ließe sich jede Zahlung per ID wegschießen).
    .is("confirmed_at", null)
    .is("deleted_at", null);
  q = "plan" in args.pool ? q.not("tranche_id", "is", null) : q.eq("item_id", args.pool.itemId);
  const { data, error } = await q.select("id");
  if (error) return { resolved: [], error: error.message };
  return { resolved: (data ?? []).map((r) => r.id as string), error: null };
}
