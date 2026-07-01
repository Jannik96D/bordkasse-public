import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { currencyLabel } from "./currencies";
import { getLiveRates } from "./get-rate";

/**
 * Eine auf dem Törn aktivierte Fremdwährung + der Kurs, der der Buchungsmaske
 * als Default mitgegeben wird.
 */
export interface CurrencyOption {
  code: string;
  label: string;
  /** EUR pro 1 Einheit Fremdwährung. null = kein Kurs verfügbar (offline + noch keine Buchung). */
  rate: number | null;
  /** Woher der Default-Kurs kommt — steuert den Hinweistext im Formular. */
  source: "live" | "last_booking" | null;
}

/**
 * Baut die Währungs-Optionen für die Buchungsmaske: erst der Live-Tageskurs
 * (Variante B), bei fehlendem Netz/Abruf der Kurs der letzten Buchung
 * derselben Währung auf diesem Törn. Gibt es beides nicht (offline + erste
 * Buchung dieser Währung), bleibt `rate = null` → das Formular verlangt eine
 * manuelle Eingabe.
 *
 * Wird beim Rendern der Buchungsseite (server-seitig) aufgerufen; der Kurs
 * reist als Default ins Formular und ist damit auch im offline gewärmten
 * Formular verfügbar.
 */
export async function getCurrencyOptions(
  tripId: string,
  foreignCurrencies: string[],
): Promise<CurrencyOption[]> {
  if (!foreignCurrencies || foreignCurrencies.length === 0) return [];

  const live = await getLiveRates(foreignCurrencies);
  const supabase = createAdminClient();
  const options: CurrencyOption[] = [];

  for (const code of foreignCurrencies) {
    const liveRate = live[code];
    if (typeof liveRate === "number") {
      options.push({ code, label: currencyLabel(code), rate: liveRate, source: "live" });
      continue;
    }
    // Offline-Fallback: Kurs der letzten Buchung derselben Währung.
    const { data } = await supabase
      .from("transactions")
      .select("exchange_rate")
      .eq("trip_id", tripId)
      .eq("original_currency", code)
      .is("deleted_at", null)
      .not("exchange_rate", "is", null)
      .order("date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastRate = data?.exchange_rate != null ? Number(data.exchange_rate) : null;
    options.push({
      code,
      label: currencyLabel(code),
      rate: lastRate,
      source: lastRate != null ? "last_booking" : null,
    });
  }

  return options;
}
