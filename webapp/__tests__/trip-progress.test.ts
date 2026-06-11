/**
 * Vitest-Suite für die Törn-Fortschritt-Logik (lib/calc/trip-progress.ts).
 * Prüft Phasen-Sichtbarkeit (Charter), Zeit-Übergänge und Item-Status.
 */

import { describe, expect, it } from "vitest";
import {
  computeTripProgress,
  type TripProgressSignals,
} from "@/lib/calc/trip-progress";

/** Basis: nichts erledigt, kein Charter. Einzelne Felder pro Test überschreiben. */
function base(overrides: Partial<TripProgressSignals> = {}): TripProgressSignals {
  return {
    startDate: "2026-06-10",
    endDate: "2026-06-20",
    isCharter: false,
    prepaymentDeclined: false,
    crewInvited: false,
    charterAdvancePaid: false,
    crewPrepaymentsComplete: false,
    firstExpenseRecorded: false,
    depositSettled: false,
    settlementAnnounced: false,
    allDebtsSettled: false,
    ...overrides,
  };
}

const phaseIds = (p: ReturnType<typeof computeTripProgress>) =>
  p.phases.map((ph) => ph.id);

describe("computeTripProgress — Phasen-Sichtbarkeit", () => {
  it("Anzahlung vorgesehen, Plan offen: kein Anzahlungs-Phase, aber offenes Plan-Item", () => {
    const p = computeTripProgress(base(), "2026-06-01");
    expect(phaseIds(p)).toEqual(["vorbereitung", "toern", "abrechnung"]);
    const vorbereitung = p.phases.find((ph) => ph.id === "vorbereitung")!;
    expect(vorbereitung.items.map((i) => i.id)).toEqual(["crew-invited", "prepayment-plan"]);
    const planItem = vorbereitung.items.find((i) => i.id === "prepayment-plan")!;
    expect(planItem.status).toBe("open");
    expect(planItem.href).toBe("prepayments/setup");
    expect(p.totalCount).toBe(6); // crew + plan + erste-ausgabe + kaution + announce + debts
  });

  it('explizit „ohne Anzahlung" (declined): weder Plan-Item noch Anzahlungs-Phase', () => {
    const p = computeTripProgress(base({ prepaymentDeclined: true }), "2026-06-01");
    expect(phaseIds(p)).toEqual(["vorbereitung", "toern", "abrechnung"]);
    const vorbereitung = p.phases.find((ph) => ph.id === "vorbereitung")!;
    expect(vorbereitung.items.map((i) => i.id)).toEqual(["crew-invited"]);
    expect(p.totalCount).toBe(5); // crew + erste-ausgabe + kaution + announce + debts
  });

  it("Charter (Plan existiert): Anzahlungs-Phase erscheint, Plan-Item ist erledigt", () => {
    const p = computeTripProgress(base({ isCharter: true }), "2026-06-01");
    expect(phaseIds(p)).toEqual([
      "vorbereitung",
      "anzahlung",
      "toern",
      "abrechnung",
    ]);
    const vorbereitung = p.phases.find((ph) => ph.id === "vorbereitung")!;
    expect(vorbereitung.items.map((i) => i.id)).toEqual(["crew-invited", "prepayment-plan"]);
    expect(vorbereitung.items.find((i) => i.id === "prepayment-plan")!.status).toBe("done");
    // 2 Vorbereitung + 2 Anzahlung + 2 Während + 2 Abrechnung
    expect(p.totalCount).toBe(8);
  });
});

describe("computeTripProgress — Zeit-/Lock-Logik", () => {
  it("vor Törn-Start: Vorbereitung offen, Abrechnungs-Items 'not_yet'", () => {
    const p = computeTripProgress(base({ crewInvited: false }), "2026-06-01");
    const crew = p.phases[0].items.find((i) => i.id === "crew-invited")!;
    expect(crew.status).toBe("open");
    const announce = p.phases
      .find((ph) => ph.id === "abrechnung")!
      .items.find((i) => i.id === "announce")!;
    expect(announce.status).toBe("not_yet");
    expect(announce.href).toBe("debts");
  });

  it("während des Törns: 'Erste Ausgabe' offen, Abrechnung weiter 'not_yet'", () => {
    const p = computeTripProgress(base(), "2026-06-15");
    const firstExpense = p.phases
      .find((ph) => ph.id === "toern")!
      .items.find((i) => i.id === "first-expense")!;
    expect(firstExpense.status).toBe("open");
    const debts = p.phases
      .find((ph) => ph.id === "abrechnung")!
      .items.find((i) => i.id === "debts-settled")!;
    expect(debts.status).toBe("not_yet");
  });

  it("ab letztem Törn-Tag (end_date − 1): Abrechnungs-Items werden 'open'", () => {
    const p = computeTripProgress(base(), "2026-06-19");
    const announce = p.phases
      .find((ph) => ph.id === "abrechnung")!
      .items.find((i) => i.id === "announce")!;
    expect(announce.status).toBe("open");
  });
});

describe("computeTripProgress — aktuelle Phase + Abschluss", () => {
  it("erste nicht-erledigte Phase ist die aktuelle", () => {
    const p = computeTripProgress(
      base({ crewInvited: true, prepaymentDeclined: true, firstExpenseRecorded: false }),
      "2026-06-15",
    );
    expect(p.currentPhaseId).toBe("toern");
    expect(p.phases.find((ph) => ph.id === "toern")!.isCurrent).toBe(true);
  });

  it("erledigtes Signal überschreibt 'not_yet' (done hat Vorrang)", () => {
    const p = computeTripProgress(
      base({ firstExpenseRecorded: true }),
      "2026-06-01", // noch vor Start → würde sonst not_yet sein
    );
    const firstExpense = p.phases
      .find((ph) => ph.id === "toern")!
      .items.find((i) => i.id === "first-expense")!;
    expect(firstExpense.status).toBe("done");
  });

  it("'Kaution verrechnet' ist manuell (Checkbox) und ohne href", () => {
    const p = computeTripProgress(base(), "2026-06-15");
    const deposit = p.phases
      .find((ph) => ph.id === "toern")!
      .items.find((i) => i.id === "deposit")!;
    expect(deposit.manual).toBe(true);
    expect(deposit.href).toBeUndefined();
    // Manueller Haken folgt weiter dem Signal: gesetzt → done.
    const set = computeTripProgress(base({ depositSettled: true }), "2026-06-15");
    expect(
      set.phases.find((ph) => ph.id === "toern")!.items.find((i) => i.id === "deposit")!.status,
    ).toBe("done");
  });

  it("'Alle Schulden beglichen' ist NICHT erledigt ohne Abrechnungs-Versand", () => {
    // Zukunfts-Charter ohne Buchungen: 0 Schulden = trivial beglichen,
    // aber noch nichts verschickt → darf nicht verfrüht grün sein.
    const p = computeTripProgress(
      base({ isCharter: true, allDebtsSettled: true, settlementAnnounced: false }),
      "2026-06-01",
    );
    const debts = p.phases
      .find((ph) => ph.id === "abrechnung")!
      .items.find((i) => i.id === "debts-settled")!;
    expect(debts.status).toBe("not_yet");
  });

  it("alles erledigt → allDone + Abschluss-Phase", () => {
    const p = computeTripProgress(
      base({
        crewInvited: true,
        prepaymentDeclined: true, // ohne Anzahlung → kein offenes Plan-Item
        firstExpenseRecorded: true,
        depositSettled: true,
        settlementAnnounced: true,
        allDebtsSettled: true,
      }),
      "2026-06-21",
    );
    expect(p.allDone).toBe(true);
    expect(p.currentPhaseId).toBe("abschluss");
    expect(p.doneCount).toBe(p.totalCount);
  });
});
