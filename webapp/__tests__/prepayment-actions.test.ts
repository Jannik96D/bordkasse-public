// Regression zu Fund 7 (Code-Review 2026-08): savePrepaymentPlan schrieb
// advancer_person_id und obligations[].person_id bisher OHNE Prüfung, ob
// diese Personen wirklich Crew des Törns sind (anders als createExpense/
// createCredit/recordPayment, die personsBelongToTrip bereits nutzen). Bei
// "individuell"/"kojen" kommen die person_id-Werte roh aus dem Client-JSON;
// bei "gleichmaessig"/"zeitanteilig" werden sie serverseitig aus trip_members
// neu berechnet und sind daher inhärent sicher — genau DAS testet der
// zweite Fall hier, damit der neue Check den Recompute-Pfad nicht
// fälschlich blockiert.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/authz", () => ({
  requireSkipperOrAdmin: vi.fn(),
}));
vi.mock("@/lib/auth/get-current-person", () => ({ getCurrentPerson: vi.fn() }));

import { savePrepaymentPlan } from "@/lib/actions/prepayments";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { requireSkipperOrAdmin } from "@/lib/auth/authz";
import { createAdminClient } from "@/lib/supabase/admin";

const mockedPerson = vi.mocked(getCurrentPerson);
const mockedRequireSkipperOrAdmin = vi.mocked(requireSkipperOrAdmin);
const mockedAdminClient = vi.mocked(createAdminClient);

const TRIP_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const CREW_1 = "aaaaaaaa-0000-4000-8000-000000000003";
const CREW_2 = "aaaaaaaa-0000-4000-8000-000000000004";
const FOREIGN_ID = "aaaaaaaa-0000-4000-8000-000000000009";

/**
 * Generischer Supabase-Mock: `trip_members` liefert für JEDE Query (sowohl
 * die gleichmaessig/zeitanteilig-Crew-Berechnung als auch den
 * personsBelongToTrip-Check) dieselbe `memberIds`-Liste — beide lesen nur
 * `person_id`, zusätzliche Spalten stören nicht.
 */
function makeSupabase(
  opts: {
    memberIds?: string[];
    /** Tabellen, deren Read einen Fehler liefern soll (Fail-loud-Pfade). */
    failReadOn?: string[];
    /**
     * Erst ab dem n-ten Read dieser Tabelle scheitern (1 = ab dem ersten).
     * Nötig für `cabin_types`: die Action liest die Tabelle ZWEIMAL — erst
     * für den Kojen-Diff (eigener, älterer Fehlercheck), danach erneut für
     * die frischen IDs. Ohne diese Unterscheidung träfe ein Test nur den
     * ersten Check und wäre für den zweiten vacuous.
     */
    failReadFromCall?: Record<string, number>;
    /** Mitschnitt der Schreib-Operationen pro Tabelle. */
    writes?: string[];
  } = {},
) {
  const { memberIds = [], failReadOn = [], failReadFromCall = {}, writes } = opts;
  const readCounts = new Map<string, number>();
  const shouldFailRead = (table: string) => {
    if (!failReadOn.includes(table)) return false;
    const n = (readCounts.get(table) ?? 0) + 1;
    readCounts.set(table, n);
    return n >= (failReadFromCall[table] ?? 1);
  };
  const tripDates = { start_date: "2026-06-01", end_date: "2026-06-10" };
  const make = (table: string) => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    b.select = self;
    b.eq = self;
    b.in = self;
    b.upsert = () => { writes?.push(`upsert:${table}`); return Promise.resolve({ error: null }); };
    b.insert = () => { writes?.push(`insert:${table}`); return Promise.resolve({ error: null }); };
    b.delete = () => { writes?.push(`delete:${table}`); return b; };
    b.update = self;
    b.single = () =>
      Promise.resolve(
        shouldFailRead(table)
          ? { data: null, error: { message: `read failed: ${table}` } }
          : table === "trips"
            ? { data: tripDates }
            : { data: null },
      );
    // assertTripNotArchived (Sanierungsplan D3) fragt `trips.archived` per
    // maybeSingle ab — tripDates trägt kein `archived`-Feld, ist also
    // implizit "nicht archiviert" (undefined ist falsy).
    b.maybeSingle = () => Promise.resolve(table === "trips" ? { data: tripDates } : { data: null });
    b.then = (onFulfilled: (v: unknown) => unknown) => {
      if (shouldFailRead(table)) {
        return Promise.resolve({ data: null, error: { message: `read failed: ${table}` } }).then(onFulfilled);
      }
      let value: unknown = { data: [], error: null };
      if (table === "trip_members") {
        value = { data: memberIds.map((person_id) => ({ person_id, on_board_from: null, on_board_to: null })) };
      }
      if (table === "cabin_types") {
        value = { data: [] };
      }
      return Promise.resolve(value).then(onFulfilled);
    };
    return b;
  };
  return { from: (table: string) => make(table) };
}

function planFormData(payload: Record<string, unknown>): FormData {
  const fd = new FormData();
  fd.set("payload", JSON.stringify(payload));
  return fd;
}

describe("savePrepaymentPlan — Cross-Trip-Schutz für Obligations (Fund 7)", () => {
  beforeEach(() => {
    mockedPerson.mockReset();
    mockedRequireSkipperOrAdmin.mockReset();
    mockedAdminClient.mockReset();
    mockedPerson.mockResolvedValue({ id: OWNER_ID, display_name: "Skipper" } as never);
    mockedRequireSkipperOrAdmin.mockResolvedValue({ ok: true, personId: OWNER_ID });
  });

  it('lehnt eine törnfremde person_id bei split_method="individuell" ab', async () => {
    // FOREIGN_ID kommt roh aus dem Client-Payload — memberIds ist leer,
    // die Person gehört also nicht zur Crew dieses Törns.
    mockedAdminClient.mockReturnValue(makeSupabase({ memberIds: [] }) as never);

    const res = await savePrepaymentPlan(
      { status: "idle" },
      planFormData({
        trip_id: TRIP_ID,
        split_method: "individuell",
        total_amount: 100,
        cabin_types: [],
        obligations: [{ person_id: FOREIGN_ID, total_amount: 100, cabin_type_id: null }],
      }),
    );

    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.message).toContain("gehört nicht zu diesem Törn");
    }
  });

  it('lehnt eine törnfremde advancer_person_id ab (unabhängig von split_method)', async () => {
    mockedAdminClient.mockReturnValue(makeSupabase({ memberIds: [CREW_1] }) as never);

    const res = await savePrepaymentPlan(
      { status: "idle" },
      planFormData({
        trip_id: TRIP_ID,
        split_method: "gleichmaessig",
        total_amount: 300,
        advancer_person_id: FOREIGN_ID,
        cabin_types: [],
        obligations: [],
      }),
    );

    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.message).toContain("gehört nicht zu diesem Törn");
    }
  });

  it('blockiert den serverseitig berechneten Pfad bei split_method="gleichmaessig" NICHT (Recompute ist bereits trip-scoped)', async () => {
    // computedObligations wird für gleichmaessig komplett aus trip_members
    // neu berechnet (das Client-Payload für `obligations` wird verworfen) —
    // der neue Check darf diesen legitimen Pfad nicht fälschlich blocken.
    mockedAdminClient.mockReturnValue(makeSupabase({ memberIds: [CREW_1, CREW_2] }) as never);

    const res = await savePrepaymentPlan(
      { status: "idle" },
      planFormData({
        trip_id: TRIP_ID,
        split_method: "gleichmaessig",
        total_amount: 300,
        cabin_types: [],
        obligations: [], // Client sendet für gleichmaessig ohnehin keine eigenen Obligations
      }),
    );

    expect(res.status).toBe("ok");
  });

  it('blockiert den serverseitig berechneten Pfad bei split_method="zeitanteilig" ebenfalls NICHT', async () => {
    mockedAdminClient.mockReturnValue(makeSupabase({ memberIds: [CREW_1, CREW_2] }) as never);

    const res = await savePrepaymentPlan(
      { status: "idle" },
      planFormData({
        trip_id: TRIP_ID,
        split_method: "zeitanteilig",
        total_amount: 300,
        cabin_types: [],
        obligations: [],
      }),
    );

    expect(res.status).toBe("ok");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Gesamtsumme ist Pflicht — für JEDE Aufteilungsmethode.
//
// `prepayment_plan.total_amount` ist gleichzeitig das Charter-Soll (was der
// Vorstrecker dem Vercharterer schuldet). Bei „individuell"/„kojen" durfte
// das Wizard-Feld früher leer bleiben und landete als 0 in der DB — womit
// die Tranchen-Vorbelegung im Buchungsformular (Plansumme × Prozent) 0,00 €
// vorschlug, das Charter-Banner und die Fortschritts-Prozent 0 zeigten und
// die Vorstrecker-Erinnerung ausfiel.
//
// Bewusst NICHT automatisch aus Σ Soll abgeleitet: nach dem ersten Speichern
// wäre „abgeleitet" nicht mehr von „so gewollt" unterscheidbar, und eine
// später geänderte Koje/Einzelsumme liefe still von der Plansumme weg. Der
// Wizard bietet stattdessen „Σ Soll übernehmen" an — ein Klick, aber eine
// bewusste Entscheidung. Eine Abweichung bleibt erlaubt (die Differenz läuft
// laut Spec über die Bordkasse), nur 0 nicht.
// ─────────────────────────────────────────────────────────────────────────
describe("savePrepaymentPlan — Gesamtsumme ist Pflicht", () => {
  beforeEach(() => {
    mockedPerson.mockReset();
    mockedRequireSkipperOrAdmin.mockReset();
    mockedAdminClient.mockReset();
    mockedPerson.mockResolvedValue({ id: OWNER_ID, display_name: "Skipper" } as never);
    mockedRequireSkipperOrAdmin.mockResolvedValue({ ok: true, personId: OWNER_ID });
  });

  it('lehnt total_amount = 0 bei "individuell" ab (Sollbeträge sind gesetzt, Charter-Soll fehlt)', async () => {
    mockedAdminClient.mockReturnValue(makeSupabase({ memberIds: [CREW_1, CREW_2] }) as never);

    const res = await savePrepaymentPlan(
      { status: "idle" },
      planFormData({
        trip_id: TRIP_ID,
        split_method: "individuell",
        total_amount: 0,
        cabin_types: [],
        obligations: [
          { person_id: CREW_1, total_amount: 300, cabin_type_id: null },
          { person_id: CREW_2, total_amount: 700, cabin_type_id: null },
        ],
      }),
    );

    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.message).toContain("Gesamtsumme");
    }
  });

  it('lehnt total_amount = 0 bei "kojen" ab (der gemeldete Fall)', async () => {
    mockedAdminClient.mockReturnValue(makeSupabase({ memberIds: [CREW_1] }) as never);

    const res = await savePrepaymentPlan(
      { status: "idle" },
      planFormData({
        trip_id: TRIP_ID,
        split_method: "kojen",
        total_amount: 0,
        cabin_types: [
          {
            id: "aaaaaaaa-0000-4000-8000-00000000000a",
            label: "Doppelkoje",
            price_per_person: 500,
            capacity: 2,
          },
        ],
        obligations: [
          { person_id: CREW_1, total_amount: 0, cabin_type_id: "aaaaaaaa-0000-4000-8000-00000000000a" },
        ],
      }),
    );

    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.message).toContain("Gesamtsumme");
    }
  });

  it("akzeptiert eine Gesamtsumme, die von Σ Soll abweicht (Differenz läuft über die Bordkasse)", async () => {
    mockedAdminClient.mockReturnValue(makeSupabase({ memberIds: [CREW_1, CREW_2] }) as never);

    const res = await savePrepaymentPlan(
      { status: "idle" },
      planFormData({
        trip_id: TRIP_ID,
        split_method: "individuell",
        total_amount: 1200,
        cabin_types: [],
        obligations: [
          { person_id: CREW_1, total_amount: 300, cabin_type_id: null },
          { person_id: CREW_2, total_amount: 700, cabin_type_id: null },
        ],
      }),
    );

    expect(res.status).toBe("ok");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Fail-loud statt still leeren Sollbeträgen.
//
// `savePrepaymentPlan` ersetzt die Sollbeträge per Delete+Insert. Scheitert
// vorher der Read, aus dem sie berechnet werden (Crew bei
// gleichmaessig/zeitanteilig, Kojen bei kojen), rechnet
// calculateObligations reihenweise 0 € — der Delete+Insert hätte die echten
// Beträge damit überschrieben und die Action trotzdem `ok` gemeldet.
//
// Die Reads laufen deshalb VOR dem ersten Write: bricht es ab, ist auch die
// Plan-Zeile noch unangetastet (kein Teilzustand „neue Methode, alte
// Sollbeträge"). Genau das prüfen diese Tests mit — der reine
// „status: error" allein wäre die schwächere Aussage.
// ─────────────────────────────────────────────────────────────────────────
describe("savePrepaymentPlan — Lesefehler dürfen Sollbeträge nicht leeren", () => {
  beforeEach(() => {
    mockedPerson.mockReset();
    mockedRequireSkipperOrAdmin.mockReset();
    mockedAdminClient.mockReset();
    mockedPerson.mockResolvedValue({ id: OWNER_ID, display_name: "Skipper" } as never);
    mockedRequireSkipperOrAdmin.mockResolvedValue({ ok: true, personId: OWNER_ID });
  });

  it("bricht ab, wenn die Crew nicht geladen werden kann — ohne Plan- oder Soll-Write", async () => {
    const writes: string[] = [];
    mockedAdminClient.mockReturnValue(
      makeSupabase({ memberIds: [CREW_1, CREW_2], failReadOn: ["trip_members"], writes }) as never,
    );

    const res = await savePrepaymentPlan(
      { status: "idle" },
      planFormData({
        trip_id: TRIP_ID,
        split_method: "gleichmaessig",
        total_amount: 1000,
        cabin_types: [],
        obligations: [],
      }),
    );

    expect(res.status).toBe("error");
    expect(writes).not.toContain("delete:prepayment_obligations");
    expect(writes).not.toContain("insert:prepayment_obligations");
    expect(writes).not.toContain("upsert:prepayment_plan");
  });

  it("bricht ab, wenn die Törndaten nicht geladen werden können — ohne Plan- oder Soll-Write", async () => {
    const writes: string[] = [];
    mockedAdminClient.mockReturnValue(
      makeSupabase({ memberIds: [CREW_1], failReadOn: ["trips"], writes }) as never,
    );

    const res = await savePrepaymentPlan(
      { status: "idle" },
      planFormData({
        trip_id: TRIP_ID,
        split_method: "zeitanteilig",
        total_amount: 1000,
        cabin_types: [],
        obligations: [],
      }),
    );

    expect(res.status).toBe("error");
    expect(writes).not.toContain("delete:prepayment_obligations");
    expect(writes).not.toContain("insert:prepayment_obligations");
  });

  it('bricht ab, wenn die Kojen nicht geladen werden können ("kojen") — ohne Soll-Write', async () => {
    // Dieser Read lässt sich NICHT vorziehen (er braucht die IDs aus dem
    // Kojen-Diff), Plan + Kojen sind hier also schon geschrieben. Die
    // Sollbeträge dürfen trotzdem nicht angefasst werden.
    const writes: string[] = [];
    mockedAdminClient.mockReturnValue(
      makeSupabase({
        memberIds: [CREW_1],
        failReadOn: ["cabin_types"],
        failReadFromCall: { cabin_types: 2 },
        writes,
      }) as never,
    );

    const res = await savePrepaymentPlan(
      { status: "idle" },
      planFormData({
        trip_id: TRIP_ID,
        split_method: "kojen",
        total_amount: 1000,
        cabin_types: [
          {
            id: "aaaaaaaa-0000-4000-8000-00000000000a",
            label: "Doppelkoje",
            price_per_person: 500,
            capacity: 2,
          },
        ],
        obligations: [
          { person_id: CREW_1, total_amount: 0, cabin_type_id: "aaaaaaaa-0000-4000-8000-00000000000a" },
        ],
      }),
    );

    expect(res.status).toBe("error");
    expect(writes).not.toContain("delete:prepayment_obligations");
    expect(writes).not.toContain("insert:prepayment_obligations");
  });
});
