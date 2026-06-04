/**
 * Törn-Fortschritt-Checkliste — reine Berechnungslogik.
 *
 * "Fortschritts-Spiegel statt Todo-Liste": jeder Status wird aus dem echten
 * Datenstand abgeleitet (siehe lib/queries/trip-progress.ts), hier nur in
 * Phasen/Items + die "aktuelle Phase" übersetzt.
 *
 * Kein DB/IO — wird im Render-Pfad UND in Vitest verwendet (Mirror-Pattern
 * wie die übrigen lib/calc/-Module).
 */

import { tripVocab, type TripType } from "@/lib/trip-vocab";

export interface TripProgressSignals {
  /** Törnstart (YYYY-MM-DD). */
  startDate: string;
  /** Törnende (YYYY-MM-DD). */
  endDate: string;
  /** Es existiert ein Anzahlungsplan → Charter-Trip, Anzahlungs-Phase zeigen. */
  isCharter: boolean;

  // Phase 1 — Vorbereitung
  crewInvited: boolean;

  // Phase 2 — Anzahlung (nur Charter)
  charterAdvancePaid: boolean;
  crewPrepaymentsComplete: boolean;

  // Phase 3 — Während des Törns
  firstExpenseRecorded: boolean;
  depositSettled: boolean;

  // Phase 4 — Abrechnung
  settlementAnnounced: boolean;
  allDebtsSettled: boolean;
}

export type ItemStatus = "done" | "open" | "not_yet";

export interface ProgressItem {
  id: string;
  label: string;
  status: ItemStatus;
  /** Pfad relativ zu /trips/[id] (z. B. "transactions/new"). Fehlt bei not_yet. */
  href?: string;
  /**
   * Manuell vom Skipper abhakbar (kein abgeleiteter Status). Die UI rendert
   * dann eine Checkbox statt eines Links. Aktuell nur "Kaution verrechnet" —
   * die automatische Erkennung lief zu unsauber (umbenannte Kategorie,
   * Gegenverrechnung per Gutschrift, …).
   */
  manual?: boolean;
}

export type PhaseId = "vorbereitung" | "anzahlung" | "toern" | "abrechnung" | "abschluss";

export interface ProgressPhase {
  id: PhaseId;
  title: string;
  items: ProgressItem[];
  /** Alle Items dieser Phase erledigt. */
  done: boolean;
  /** Die Phase, auf die der Skipper gerade schauen soll → aufgeklappt. */
  isCurrent: boolean;
}

export interface TripProgress {
  phases: ProgressPhase[];
  currentPhaseId: PhaseId;
  doneCount: number;
  totalCount: number;
  allDone: boolean;
}

/** Phasen-Reihenfolge für die Zeit-/Lock-Logik. */
const PHASE_ORDER: Exclude<PhaseId, "abschluss">[] = [
  "vorbereitung",
  "anzahlung",
  "toern",
  "abrechnung",
];

/**
 * Bis zu welchem Phasen-Index sind Items aktuell "dran" (anhand des Datums)?
 *   - vor Törnstart          → Vorbereitung + Anzahlung (Index 1)
 *   - während des Törns        → + Während des Törns (Index 2)
 *   - ab letztem Törn-Tag      → alles (Index 3)
 *
 * Der Settlement-Cutoff (end_date − 1 Tag) ist exakt derselbe wie im
 * Settlement-Banner (components/settlement-status.tsx).
 */
function timeUnlockedUpTo(startDate: string, endDate: string, todayIso: string): number {
  const cutoff = new Date(endDate);
  cutoff.setDate(cutoff.getDate() - 1);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  if (todayIso >= cutoffIso) return 3; // Abrechnung
  if (todayIso >= startDate) return 2; // Während des Törns
  return 1; // Vorbereitung + Anzahlung
}

function statusFor(done: boolean, phaseIndex: number, unlockedUpTo: number): ItemStatus {
  if (done) return "done";
  if (phaseIndex > unlockedUpTo) return "not_yet";
  return "open";
}

export function computeTripProgress(
  s: TripProgressSignals,
  todayIso: string,
  tripType: TripType = "sailing",
): TripProgress {
  const vocab = tripVocab(tripType);
  const unlockedUpTo = timeUnlockedUpTo(s.startDate, s.endDate, todayIso);
  const idx = (id: Exclude<PhaseId, "abschluss">) => PHASE_ORDER.indexOf(id);

  const phases: ProgressPhase[] = [];

  // ── Phase 1 — Vorbereitung ──────────────────────────────────────────
  // "Anzahlungsplan anlegen" ist bewusst KEIN Checklisten-Item: ein Plan wird
  // über den kontextuellen CTA auf der Übersicht (showCreatePrepaymentCta)
  // angestoßen, und die Anzahlungs-Phase erscheint erst, wenn der Plan
  // existiert (isCharter). Ein Item dafür wäre strukturell immer "erledigt".
  const vorbereitungItems: ProgressItem[] = [
    {
      id: "crew-invited",
      label: `${vocab.crew} einladen`,
      status: statusFor(s.crewInvited, idx("vorbereitung"), unlockedUpTo),
      href: "settings",
    },
  ];
  phases.push(makePhase("vorbereitung", "Vorbereitung", vorbereitungItems));

  // ── Phase 2 — Anzahlung (nur Charter) ───────────────────────────────
  if (s.isCharter) {
    const anzahlungItems: ProgressItem[] = [
      {
        id: "charter-advance",
        label: `${vocab.prepayment} an ${vocab.provider} erfasst`,
        status: statusFor(s.charterAdvancePaid, idx("anzahlung"), unlockedUpTo),
        href: "prepayments",
      },
      {
        id: "crew-prepayments",
        label: tripType === "other" ? "Alle Anzahlungen der Reisegruppe eingegangen" : "Alle Crewanzahlungen eingegangen",
        status: statusFor(s.crewPrepaymentsComplete, idx("anzahlung"), unlockedUpTo),
        href: "prepayments",
      },
    ];
    phases.push(makePhase("anzahlung", "Anzahlung einsammeln", anzahlungItems));
  }

  // ── Phase 3 — Während des Törns ─────────────────────────────────────
  const toernItems: ProgressItem[] = [
    {
      id: "first-expense",
      label: "Erste Ausgabe erfasst",
      status: statusFor(s.firstExpenseRecorded, idx("toern"), unlockedUpTo),
      href: "transactions/new",
    },
    {
      id: "deposit",
      label: "Kaution verrechnet",
      status: statusFor(s.depositSettled, idx("toern"), unlockedUpTo),
      // Manuell abgehakt — kein href (Checkbox statt Link).
      manual: true,
    },
  ];
  phases.push(makePhase("toern", "Während des Törns", toernItems));

  // ── Phase 4 — Abrechnung ────────────────────────────────────────────
  const abrechnungItems: ProgressItem[] = [
    {
      id: "announce",
      label: "Abrechnung verschicken",
      status: statusFor(s.settlementAnnounced, idx("abrechnung"), unlockedUpTo),
      href: "debts",
    },
    {
      id: "debts-settled",
      label: "Alle Schulden beglichen",
      // Erst sinnvoll "erledigt", wenn auch die Abrechnung verschickt wurde —
      // sonst zeigt ein Törn ganz ohne Buchungen (0 Schulden = trivial
      // beglichen) den Haken verfrüht.
      status: statusFor(
        s.allDebtsSettled && s.settlementAnnounced,
        idx("abrechnung"),
        unlockedUpTo,
      ),
      href: "debts",
    },
  ];
  phases.push(makePhase("abrechnung", "Abrechnung", abrechnungItems));

  // ── Aggregate + aktuelle Phase ──────────────────────────────────────
  const allItems = phases.flatMap((p) => p.items);
  const doneCount = allItems.filter((i) => i.status === "done").length;
  const totalCount = allItems.length;
  const allDone = doneCount === totalCount;

  // Aktuelle Phase = erste nicht vollständig erledigte Phase. Bei allem
  // erledigt → synthetische Abschluss-Phase (Karte kollabiert in der UI).
  const currentPhaseId: PhaseId = allDone
    ? "abschluss"
    : (phases.find((p) => !p.done)?.id ?? "vorbereitung");

  for (const p of phases) p.isCurrent = p.id === currentPhaseId;

  return { phases, currentPhaseId, doneCount, totalCount, allDone };
}

function makePhase(
  id: PhaseId,
  title: string,
  items: ProgressItem[],
): ProgressPhase {
  return {
    id,
    title,
    items,
    done: items.every((i) => i.status === "done"),
    isCurrent: false, // wird unten gesetzt
  };
}
