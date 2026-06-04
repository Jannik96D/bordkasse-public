/**
 * Reise-typ-abhängiges Vokabular.
 *
 * Ein Törn ist entweder ein klassischer Segeltörn (`sailing`, Default) oder
 * eine „Andere Reise" (`other`, z. B. Gruppen-Urlaub). Für `other` zeigt die
 * Oberfläche INNERHALB einer Reise durchgehend neutrale Begriffe.
 *
 * Reine Funktion, in Server- UND Client-Komponenten importierbar. Client-
 * Komponenten holen sich das Vokabular bequem über `useTripVocab()`
 * (components/trip-vocab-provider.tsx, im Trip-Layout gemountet); Server-
 * Komponenten rufen `tripVocab(trip.trip_type)` lokal.
 *
 * WICHTIG (Scope): Die Umbenennung von „Törn"→„Reise" und „Bordkasse"→
 * „Urlaubskasse" gilt NUR innerhalb einer Reise (app/trips/[id]/** + Mails),
 * NICHT auf den übergreifenden Seiten (Trip-Liste, Landing, /about,
 * /datenschutz, /kontakt) — dort bleiben „Törn"/„Bordkasse" als feste
 * Produkt-/Markenbegriffe stehen.
 *
 * Alle Begriffe sind hier zentralisiert (eine Quelle) — einen Begriff ändern
 * = eine Zeile ändern.
 */

export type TripType = "sailing" | "other";

export interface TripVocab {
  // ── Reise als Ganzes ────────────────────────────────────────────────
  /** „Törn" / „Reise" */
  trip: string;
  /** „Törnstart" / „Reisebeginn" */
  tripStart: string;
  /** „Törnende" / „Reiseende" */
  tripEnd: string;
  /** Die gemeinsame Kasse: „Bordkasse" / „Urlaubskasse" */
  kitty: string;

  // ── Gruppe / Personen ───────────────────────────────────────────────
  /** „Crew" / „Reisegruppe" */
  crew: string;
  /** „Crewmitglied" / „Mitreisende:r" */
  member: string;
  /** Mitglied im Dativ für Sätze („von einem …"). */
  memberDative: string;
  /** CTA: „Crewmitglied hinzufügen" / „Person hinzufügen" */
  addMember: string;
  /** Beiträge der Gruppe: „Crewbeiträge" / „Beiträge der Gruppe" */
  contributions: string;
  /** Rolle: „Skipper" / „Reiseleitung" (geschlechtsneutral) */
  skipper: string;
  /** Rolle: „Co-Skipper" / „Co-Reiseleitung" */
  coSkipper: string;

  // ── Anwesenheit / Aufteilung „an Bord" ──────────────────────────────
  /** Aufteilungs-Art + Anwesenheits-Konzept: „An Bord" / „Anwesend". */
  onBoard: string;

  // ── Unterkunft / Kojen ──────────────────────────────────────────────
  /** „Schiffsname" / „Unterkunft" */
  shipName: string;
  /** Platzhalter im Namensfeld. */
  shipNamePlaceholder: string;
  /** Einzelne Einheit der Kojen-Aufteilung: „Koje" / „Zimmer" */
  cabin: string;
  /** Plural: „Kojen" / „Zimmer" */
  cabinPlural: string;
  /** Default-Label für eine neue Einheit: „Doppelkoje" / „Doppelzimmer" */
  cabinDefaultLabel: string;

  // ── Anzahlung / Anbieter ────────────────────────────────────────────
  /** „Yachtanzahlung" / „Urlaubsanzahlung" */
  prepayment: string;
  /** Das gecharterte Objekt bzw. die Reise: „Yachtcharter" / „die Reise" */
  charterObject: string;
  /** Anbieter, an den vorab gezahlt wird: „Vercharterer" / „Anbieter" */
  provider: string;
  /** Variante „Charteragentur" / „Anbieter" */
  agency: string;
  /** Offene Posten an den Anbieter: „Offene Charteranzahlungen" / „Offene Anzahlungen" */
  openPrepayments: string;
}

const SAILING: TripVocab = {
  trip: "Törn",
  tripStart: "Törnstart",
  tripEnd: "Törnende",
  kitty: "Bordkasse",

  crew: "Crew",
  member: "Crewmitglied",
  memberDative: "Crewmitglied",
  addMember: "Crewmitglied hinzufügen",
  contributions: "Crewbeiträge",
  skipper: "Skipper",
  coSkipper: "Co-Skipper",

  onBoard: "An Bord",

  shipName: "Schiffsname",
  shipNamePlaceholder: "z. B. Bavaria 36",
  cabin: "Koje",
  cabinPlural: "Kojen",
  cabinDefaultLabel: "Doppelkoje",

  prepayment: "Yachtanzahlung",
  charterObject: "Yachtcharter",
  provider: "Vercharterer",
  agency: "Charteragentur",
  openPrepayments: "Offene Charteranzahlungen",
};

const OTHER: TripVocab = {
  trip: "Reise",
  tripStart: "Reisebeginn",
  tripEnd: "Reiseende",
  kitty: "Urlaubskasse",

  crew: "Reisegruppe",
  member: "Mitreisende:r",
  memberDative: "Mitglied der Reisegruppe",
  addMember: "Person hinzufügen",
  contributions: "Beiträge der Gruppe",
  skipper: "Reiseleitung",
  coSkipper: "Co-Reiseleitung",

  onBoard: "Anwesend",

  shipName: "Unterkunft",
  shipNamePlaceholder: "z. B. Ferienwohnung",
  cabin: "Zimmer",
  cabinPlural: "Zimmer",
  cabinDefaultLabel: "Doppelzimmer",

  prepayment: "Urlaubsanzahlung",
  charterObject: "die Reise",
  provider: "Anbieter",
  agency: "Anbieter",
  openPrepayments: "Offene Anzahlungen",
};

/** Liefert das Vokabular für den Reise-Typ. Unbekannt/leer ⇒ Segeltörn. */
export function tripVocab(tripType: TripType | string | null | undefined): TripVocab {
  return tripType === "other" ? OTHER : SAILING;
}
