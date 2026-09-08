// Regressionstests zum Sanierungsplan PR 9b — "Anzahlungen-Hygiene".
//
// Fund A: saveTranches löschte eine Tranche mit bereits BESTÄTIGTEN Zahlungen
// stillschweigend (ON DELETE SET NULL wirft die Buchung ohne Warnung aus dem
// Anzahlungs-Pool). Fund B: savePrepaymentPlan upsertete eine cabin_type_id
// aus dem Client-Payload ungeprüft — eine ID, die zu einer Koje eines
// FREMDEN Törns gehört, hätte diese Zeile stillschweigend gekapert. Fund C:
// recordPayment zählte beim Overflow-Split auch unbestätigte Selbstmeldungen
// (confirmed_at = NULL) als "bereits bezahlt".
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue(new Map()) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/authz", () => ({
  requireSkipperOrAdmin: vi.fn(),
  requireMember: vi.fn(),
  requireSkipperAdminOrAdvancer: vi.fn(),
}));
vi.mock("@/lib/auth/get-current-person", () => ({ getCurrentPerson: vi.fn() }));
vi.mock("@/lib/notify/web-push", () => ({ sendPushToPersons: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/notify/recipients", () => ({ pushRecipients: vi.fn(() => []) }));
vi.mock("@/lib/notify/payloads", () => ({
  paymentPendingPush: vi.fn(() => ({})),
  paymentConfirmedPush: vi.fn(() => ({})),
  paymentRejectedPush: vi.fn(() => ({})),
}));

import { saveTranches, savePrepaymentPlan, recordPayment } from "@/lib/actions/prepayments";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { requireSkipperOrAdmin, requireSkipperAdminOrAdvancer } from "@/lib/auth/authz";
import { createAdminClient } from "@/lib/supabase/admin";

const mockedPerson = vi.mocked(getCurrentPerson);
const mockedRequireSkipperOrAdmin = vi.mocked(requireSkipperOrAdmin);
const mockedAdvancer = vi.mocked(requireSkipperAdminOrAdvancer);
const mockedAdminClient = vi.mocked(createAdminClient);

const TRIP_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const TRANCHE_1 = "aaaaaaaa-0000-4000-8000-000000000010";
const TRANCHE_2 = "aaaaaaaa-0000-4000-8000-000000000011";
const CABIN_FOREIGN = "aaaaaaaa-0000-4000-8000-000000000020";
const SKIPPER_ID = "aaaaaaaa-0000-4000-8000-000000000031";
const OVERFLOW_TRANCHE = "aaaaaaaa-0000-4000-8000-000000000032";

function fd(payload: Record<string, unknown>): FormData {
  const f = new FormData();
  f.set("payload", JSON.stringify(payload));
  return f;
}

// ─────────────────────────────────────────────────────────────────────────
// Fund A — saveTranches: Löschen einer Tranche mit bestätigten Zahlungen
// ─────────────────────────────────────────────────────────────────────────
describe("saveTranches — blockt Löschen einer Tranche mit bestätigten Zahlungen (Fund A)", () => {
  function makeSupabase(opts: { confirmedCount: number }, calls: Array<{ table: string; col: unknown; val: unknown }> = []) {
    const { confirmedCount } = opts;
    return {
      from: (table: string) => {
        let counting = false;
        const b: Record<string, unknown> = {};
        const self = () => b;
        b.select = (_cols?: unknown, options?: { count?: string }) => {
          if (options?.count) counting = true;
          return b;
        };
        b.eq = (col: unknown, val: unknown) => {
          calls.push({ table, col, val });
          return b;
        };
        b.in = self;
        b.not = self;
        b.is = self;
        b.update = self;
        b.delete = self;
        b.insert = () => Promise.resolve({ error: null });
        b.maybeSingle = () => Promise.resolve(table === "trips" ? { data: { archived: false } } : { data: null });
        b.then = (onFulfilled: (v: unknown) => unknown) => {
          let value: unknown = { data: [], error: null };
          if (table === "prepayment_tranches") {
            // Existierende Tranchen: TRANCHE_1 (bleibt) + TRANCHE_2 (wird gelöscht)
            value = { data: [{ id: TRANCHE_1 }, { id: TRANCHE_2 }] };
          }
          if (table === "transactions" && counting) {
            value = { count: confirmedCount, data: null };
          }
          return Promise.resolve(value).then(onFulfilled);
        };
        return b;
      },
    };
  }

  beforeEach(() => {
    mockedPerson.mockReset();
    mockedRequireSkipperOrAdmin.mockReset();
    mockedAdminClient.mockReset();
    mockedPerson.mockResolvedValue({ id: OWNER_ID, display_name: "Skipper" } as never);
    mockedRequireSkipperOrAdmin.mockResolvedValue({ ok: true, personId: OWNER_ID });
  });

  it("lehnt das Speichern ab, wenn die zu löschende Tranche bestätigte Zahlungen hat", async () => {
    mockedAdminClient.mockReturnValue(makeSupabase({ confirmedCount: 1 }) as never);

    // Payload enthält nur noch TRANCHE_1 → TRANCHE_2 würde gelöscht.
    const res = await saveTranches(
      { status: "idle" },
      fd({
        trip_id: TRIP_ID,
        tranches: [
          { id: TRANCHE_1, due_date: "2026-06-01", label: "Endzahlung", percent: 100, sort_order: 0 },
        ],
      }),
    );

    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.message).toContain("bestätigte Zahlungen");
    }
  });

  it("erlaubt das Löschen, wenn keine bestätigten Zahlungen an der Tranche hängen", async () => {
    mockedAdminClient.mockReturnValue(makeSupabase({ confirmedCount: 0 }) as never);

    const res = await saveTranches(
      { status: "idle" },
      fd({
        trip_id: TRIP_ID,
        tranches: [
          { id: TRANCHE_1, due_date: "2026-06-01", label: "Endzahlung", percent: 100, sort_order: 0 },
        ],
      }),
    );

    expect(res.status).toBe("ok");
  });

  it("blockt auch, wenn die bereits gezahlte Charter-Rate eine EXPENSE (nicht credit) mit derselben tranche_id ist (Grill-Review-Fix)", async () => {
    // Die Charter-Zahlung selbst (Vorstrecker → Vercharterer) ist eine
    // Ausgabe, keine Gutschrift (siehe getCharterPaidTotal/-PerTranche in
    // lib/queries/prepayments.ts). Der ursprüngliche Fix filterte fälschlich
    // auf type="credit" — eine bereits gezahlte Charter-Rate wäre beim
    // Löschen der Tranche unbemerkt in den Bordkasse-Pool gefallen.
    const calls: Array<{ table: string; col: unknown; val: unknown }> = [];
    mockedAdminClient.mockReturnValue(makeSupabase({ confirmedCount: 1 }, calls) as never);

    const res = await saveTranches(
      { status: "idle" },
      fd({
        trip_id: TRIP_ID,
        tranches: [
          { id: TRANCHE_1, due_date: "2026-06-01", label: "Endzahlung", percent: 100, sort_order: 0 },
        ],
      }),
    );

    expect(res.status).toBe("error");
    // Mutation-Guard: die Prüfung darf NICHT mehr nach type="credit" filtern
    // — sonst würde eine expense-Charter-Zahlung nicht mitgezählt.
    expect(
      calls.some((c) => c.table === "transactions" && c.col === "type" && c.val === "credit"),
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Fund B — savePrepaymentPlan: cabin_type_id aus einem FREMDEN Törn
// ─────────────────────────────────────────────────────────────────────────
describe("savePrepaymentPlan — blockt eine cabin_type_id aus einem fremden Törn (Fund B)", () => {
  function makeSupabase(opts: { cabinExistsElsewhere: boolean; ownCabinSelectErrors?: boolean }) {
    const { cabinExistsElsewhere, ownCabinSelectErrors = false } = opts;
    return {
      from: (table: string) => {
        let usedIn = false;
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = () => b; // trip_id-gefilterte Kojen-Query dieses Törns
        b.in = () => {
          usedIn = true;
          return b;
        };
        b.upsert = () => Promise.resolve({ error: null });
        b.delete = () => b;
        b.insert = () => Promise.resolve({ error: null });
        b.update = () => b;
        b.maybeSingle = () => Promise.resolve(table === "trips" ? { data: { archived: false } } : { data: null });
        b.single = () => Promise.resolve({ data: null });
        b.then = (onFulfilled: (v: unknown) => unknown) => {
          let value: unknown = { data: [], error: null };
          if (table === "cabin_types") {
            if (!usedIn && ownCabinSelectErrors) {
              // Die trip-eigene Kojen-Query (kein .in()) schlägt fehl — Grill-
              // Review-Fix: das MUSS jetzt fail-loud abgebrochen werden, statt
              // existingCabinIds still leer zu lassen (was sonst JEDE
              // eigene Koje fälschlich als "fremd" behandelt hätte).
              value = { data: null, error: { message: "boom" } };
            } else {
              // Ohne .in(): die trip-eigene Kojen-Query → dieser Törn hat noch
              // KEINE Kojen (existingCabinIds = leer, die eingehende ID ist
              // also "unbekannt für diesen Törn").
              // Mit .in(): die globale Existenz-Prüfung (Fund B) — die Koje
              // gehört tatsächlich zu einem ANDEREN Törn.
              value = usedIn ? { data: cabinExistsElsewhere ? [{ id: CABIN_FOREIGN }] : [] } : { data: [] };
            }
          }
          if (table === "trip_members") value = { data: [] };
          return Promise.resolve(value).then(onFulfilled);
        };
        return b;
      },
    };
  }

  beforeEach(() => {
    mockedPerson.mockReset();
    mockedRequireSkipperOrAdmin.mockReset();
    mockedAdminClient.mockReset();
    mockedPerson.mockResolvedValue({ id: OWNER_ID, display_name: "Skipper" } as never);
    mockedRequireSkipperOrAdmin.mockResolvedValue({ ok: true, personId: OWNER_ID });
  });

  it("lehnt eine cabin_type_id ab, die zu einem fremden Törn gehört", async () => {
    mockedAdminClient.mockReturnValue(makeSupabase({ cabinExistsElsewhere: true }) as never);

    const res = await savePrepaymentPlan(
      { status: "idle" },
      fd({
        trip_id: TRIP_ID,
        split_method: "individuell",
        total_amount: 100,
        cabin_types: [
          { id: CABIN_FOREIGN, label: "Doppel", price_per_person: 100, capacity: 2, sort_order: 0 },
        ],
        obligations: [],
      }),
    );

    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.message).toContain("Koje");
    }
  });

  it("erlaubt eine brandneue, noch nirgends existierende cabin_type_id", async () => {
    mockedAdminClient.mockReturnValue(makeSupabase({ cabinExistsElsewhere: false }) as never);

    const res = await savePrepaymentPlan(
      { status: "idle" },
      fd({
        trip_id: TRIP_ID,
        split_method: "individuell",
        total_amount: 100,
        cabin_types: [
          { id: CABIN_FOREIGN, label: "Doppel", price_per_person: 100, capacity: 2, sort_order: 0 },
        ],
        obligations: [],
      }),
    );

    expect(res.status).toBe("ok");
  });

  it("bricht fail-loud ab, statt bei einem DB-Fehler eigene Kojen fälschlich als fremd zu blocken (Grill-Review-Fix)", async () => {
    // Vor dem Fix: existingCabinIds blieb bei einem Fehler leer →
    // JEDE Koje DIESES Törns zählte als "unbekannt", die globale Existenz-
    // Prüfung fand sie (sie existieren ja) und der Save wurde dauerhaft mit
    // "gehört nicht zu diesem Törn" blockiert — ein Fehler ohne Ausweg.
    mockedAdminClient.mockReturnValue(
      makeSupabase({ cabinExistsElsewhere: false, ownCabinSelectErrors: true }) as never,
    );

    const res = await savePrepaymentPlan(
      { status: "idle" },
      fd({
        trip_id: TRIP_ID,
        split_method: "individuell",
        total_amount: 100,
        cabin_types: [
          { id: CABIN_FOREIGN, label: "Doppel", price_per_person: 100, capacity: 2, sort_order: 0 },
        ],
        obligations: [],
      }),
    );

    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.message).not.toContain("gehört nicht zu diesem Törn");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Fund C — recordPayment: nur bestätigte Zahlungen zählen als "bereits bezahlt"
// ─────────────────────────────────────────────────────────────────────────
describe("recordPayment — zählt nur bestätigte Zahlungen als 'bereits bezahlt' (Fund C)", () => {
  function makeSupabase() {
    const capturedInserts: Array<{ table: string; row: Record<string, unknown> }> = [];
    const supabase = {
      from: (table: string) => {
        let filteredConfirmed = false;
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = () => b;
        b.in = () => b; // personsBelongToTrip (trip_members)
        b.not = (col: string, _op: string, val: unknown) => {
          if (col === "confirmed_at" && val === null) filteredConfirmed = true;
          return b;
        };
        b.is = () => b;
        b.insert = (row: Record<string, unknown>) => {
          capturedInserts.push({ table, row });
          return Promise.resolve({ error: null });
        };
        b.maybeSingle = () => {
          if (table === "trips") return Promise.resolve({ data: { skipper_id: SKIPPER_ID, archived: false } });
          if (table === "prepayment_plan") return Promise.resolve({ data: { advancer_person_id: null } });
          if (table === "prepayment_obligations") return Promise.resolve({ data: { total_amount: 100 } });
          if (table === "prepayment_tranches") return Promise.resolve({ data: { id: "x", percent: 100, label: "Endzahlung" } });
          return Promise.resolve({ data: null });
        };
        // Thenable für die "bereits gezahlt"-Query auf `transactions`. Eine
        // unbestätigte Selbstmeldung (confirmed_at: null) liegt bereits vor
        // Betrag 100 — OHNE den confirmed_at-Filter (alter Code) zählt sie
        // mit, MIT Filter (neuer Code, erkennbar an .not("confirmed_at", …))
        // wird sie herausgefiltert.
        b.then = (onFulfilled: (v: unknown) => unknown) => {
          let value: unknown = { data: [], error: null };
          if (table === "transactions") {
            const rows = [{ amount: 100, confirmed_at: null as string | null }];
            value = { data: filteredConfirmed ? rows.filter((r) => r.confirmed_at !== null) : rows };
          }
          if (table === "trip_members") {
            value = { data: [{ person_id: SKIPPER_ID }] };
          }
          return Promise.resolve(value).then(onFulfilled);
        };
        return b;
      },
    };
    return { supabase, capturedInserts };
  }

  beforeEach(() => {
    mockedPerson.mockReset();
    mockedAdvancer.mockReset();
    mockedAdminClient.mockReset();
    // Actor == Vorstrecker(=Skipper) == Zielperson → keine Notice-Mail nötig,
    // damit dieser Test sich auf die confirmed_at-Logik konzentrieren kann.
    mockedPerson.mockResolvedValue({ id: SKIPPER_ID, display_name: "Skipper" } as never);
    mockedAdvancer.mockResolvedValue({ ok: true, personId: SKIPPER_ID });
  });

  function paymentFormData(): FormData {
    const f = new FormData();
    f.set("trip_id", TRIP_ID);
    f.set("tranche_id", "aaaaaaaa-0000-4000-8000-000000000040");
    f.set("person_id", SKIPPER_ID);
    f.set("amount", "60");
    f.set("date", "2026-06-05");
    f.set("overflow_tranche_id", OVERFLOW_TRANCHE);
    return f;
  }

  it("bucht den vollen Betrag auf die Ziel-Tranche, wenn die einzige bestehende Zahlung unbestätigt ist", async () => {
    const { supabase, capturedInserts } = makeSupabase();
    mockedAdminClient.mockReturnValue(supabase as never);

    const res = await recordPayment({ status: "idle" }, paymentFormData());

    expect(res.status).toBe("ok");
    const txInserts = capturedInserts.filter((c) => c.table === "transactions");
    expect(txInserts).toHaveLength(1);
    // Ohne den confirmed_at-Filter (Bug) hätte "open" bei 0 gelegen und der
    // GESAMTE Betrag wäre auf die Overflow-Tranche gebucht worden, nichts
    // auf die eigentliche Ziel-Tranche.
    expect(txInserts[0].row.tranche_id).toBe("aaaaaaaa-0000-4000-8000-000000000040");
    expect(txInserts[0].row.amount).toBe(60);
  });
});
