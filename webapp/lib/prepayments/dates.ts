/**
 * Datum-Helpers für das Anzahlungs-Modul.
 *
 * Konvention: `prepayment_tranches.due_date` ist das Charter-Fälligkeits-
 * Datum (Vorstrecker → Agentur). Die Crew bekommt einen 3-Tage-Puffer
 * davor, damit der Vorstrecker das Geld rechtzeitig zusammen hat.
 */

/** Anzahl Tage, die die Crew vor der Charter-Fälligkeit zahlen soll. */
export const CREW_DUE_DAYS_BEFORE_CHARTER = 3;

/** Heute als ISO-Date (UTC), zeitzonenneutral wie der Rest des Moduls. */
function todayIsoUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Aus einer Charter-Fälligkeit (ISO YYYY-MM-DD) die Crew-Fälligkeit
 * (3 Tage davor) berechnen. Zeit-Zone-neutral via UTC, damit Sommerzeit-
 * Wechsel die Berechnung nicht verschiebt.
 *
 * Clamp: solange die Charterfrist noch aussteht, rutscht die Crewfrist nicht
 * in die Vergangenheit (sonst sähe die Crew „bis gestern", obwohl die Zahlung
 * noch ansteht) — aber sie liegt nie nach der Charterfrist selbst. `today`
 * ist überschreibbar für deterministische Tests.
 */
export function toCrewDueDate(charterDueDateIso: string, today: string = todayIsoUtc()): string {
  if (!charterDueDateIso) return charterDueDateIso;
  const d = new Date(`${charterDueDateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - CREW_DUE_DAYS_BEFORE_CHARTER);
  let crewDue = d.toISOString().slice(0, 10);
  // ISO YYYY-MM-DD vergleicht lexikografisch = chronologisch.
  if (crewDue < today) {
    crewDue = today < charterDueDateIso ? today : charterDueDateIso;
  }
  return crewDue;
}

/**
 * Numerisches deutsches Datum: ISO "2026-04-05" → "5.4.2026".
 * Wird in Matrix-Header, Mails, WhatsApp-Texten verwendet — überall dort, wo
 * das ausführliche `lib/utils.ts:formatDate` ("5. Apr. 2026") zu lang wäre.
 */
export function formatDeDate(iso: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${Number(d)}.${Number(m)}.${y}`;
}

/**
 * Addiert `days` zu einem ISO-Date (YYYY-MM-DD), zeitzonenneutral via UTC.
 * Wird vom Reminder-Cron für die Target-Daten verwendet.
 */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
