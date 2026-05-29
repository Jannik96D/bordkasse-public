/**
 * Datum-Helpers für das Anzahlungs-Modul.
 *
 * Konvention: `prepayment_tranches.due_date` ist das Charter-Fälligkeits-
 * Datum (Vorstrecker → Agentur). Die Crew bekommt einen 3-Tage-Puffer
 * davor, damit der Vorstrecker das Geld rechtzeitig zusammen hat.
 */

/** Anzahl Tage, die die Crew vor der Charter-Fälligkeit zahlen soll. */
export const CREW_DUE_DAYS_BEFORE_CHARTER = 3;

/**
 * Aus einer Charter-Fälligkeit (ISO YYYY-MM-DD) die Crew-Fälligkeit
 * (3 Tage davor) berechnen. Zeit-Zone-neutral via UTC, damit Sommerzeit-
 * Wechsel die Berechnung nicht verschiebt.
 */
export function toCrewDueDate(charterDueDateIso: string): string {
  if (!charterDueDateIso) return charterDueDateIso;
  const d = new Date(`${charterDueDateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - CREW_DUE_DAYS_BEFORE_CHARTER);
  return d.toISOString().slice(0, 10);
}
