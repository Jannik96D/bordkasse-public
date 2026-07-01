import { round2 } from "@/lib/utils";

/**
 * Rechnet einen Fremdwährungs-Betrag in Euro um, auf Cent gerundet.
 * `rateEurPerUnit` = wie viele Euro 1 Einheit der Fremdwährung wert ist
 * (z. B. SEK-Kurs 0,0903 → 500 SEK × 0,0903 = 45,15 €).
 *
 * Reine Funktion, in Client (Livevorschau) UND Server (Speichern) genutzt,
 * damit die Umrechnung an beiden Stellen identisch ist.
 */
export function foreignToEur(foreignAmount: number, rateEurPerUnit: number): number {
  return round2(foreignAmount * rateEurPerUnit);
}
