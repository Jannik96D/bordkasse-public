// replaceMember (Crewwechsel A → B) — Regressionen für die beim
// UI-Anbinden gefundenen Bugs (lib/actions/prepayments.ts):
//  1. Der Payment-Transfer-Query filterte nicht auf confirmed_at, hätte
//     also eine unbestätigte Selbstmeldung wie eine echte Zahlung
//     übernommen.
//  2. Ohne Pre-Check hätte eine offene, unbestätigte Selbstmeldung nach
//     dem Wechsel an der (jetzt "abgereisten") alten Person hängen
//     bleiben können, während ihr Anzahlungssoll schon umgezogen ist.
//  3. Eine new_email, die schon zu einem ANDEREN Crewmitglied desselben
//     Törns gehört, hätte dessen trip_members-/Obligation-Zeile
//     stillschweigend überschrieben statt abzulehnen.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/authz", () => ({
  requireSkipperOrAdmin: vi.fn(),
  requireMember: vi.fn(),
  requireSkipperAdminOrAdvancer: vi.fn(),
}));
vi.mock("@/lib/auth/get-current-person", () => ({ getCurrentPerson: vi.fn() }));

import { replaceMember } from "@/lib/actions/prepayments";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { requireSkipperOrAdmin } from "@/lib/auth/authz";
import { createAdminClient } from "@/lib/supabase/admin";

const mockedPerson = vi.mocked(getCurrentPerson);
const mockedAuth = vi.mocked(requireSkipperOrAdmin);
const mockedAdminClient = vi.mocked(createAdminClient);

// RFC-4122-valide Seed-UUIDs (Zod v4 .uuid() ist strikt).
const TRIP_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const SKIPPER_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const OLD_PERSON_ID = "aaaaaaaa-0000-4000-8000-000000000003";
const ACTOR_ID = "aaaaaaaa-0000-4000-8000-000000000004";
const OLD_MEMBER_ROW_ID = "aaaaaaaa-0000-4000-8000-000000000005";
const CABIN_ID = "aaaaaaaa-0000-4000-8000-000000000006";
const TRANCHE_ID = "aaaaaaaa-0000-4000-8000-000000000007";
const EXISTING_MEMBER_PERSON_ID = "aaaaaaaa-0000-4000-8000-000000000008";
const EXISTING_MEMBER_ROW_ID = "aaaaaaaa-0000-4000-8000-000000000009";

const CONFIRMED_PAYMENT = {
  id: "tx-confirmed",
  trip_id: TRIP_ID,
  credit_from: OLD_PERSON_ID,
  type: "credit",
  tranche_id: TRANCHE_ID,
  deleted_at: null,
  confirmed_at: "2026-08-01T10:00:00Z",
  amount: 202.5,
  date: "2026-08-01",
};

const PENDING_SELF_REPORT = {
  id: "tx-pending",
  trip_id: TRIP_ID,
  credit_from: OLD_PERSON_ID,
  type: "credit",
  tranche_id: TRANCHE_ID,
  deleted_at: null,
  confirmed_at: null, // unbestätigte Selbstmeldung
  amount: 999,
  date: "2026-08-02",
};

type Call = { table: string; op: string; payload?: unknown };

/**
 * Minimaler In-Memory-Postgrest-Mock: `.eq`/`.not`/`.is` filtern die
 * kanonischen Zeilen im "select"-Modus wirklich (statt sie zu ignorieren),
 * damit der Test die tatsächliche Query-Bedingung prüft — nicht nur, dass
 * irgendwas zurückkommt. `transactions` ist pro Test überschreibbar, um
 * "nur bestätigt" von "hat noch eine offene Selbstmeldung" zu unterscheiden.
 */
function makeSupabase(calls: Call[], transactionsRows: Array<Record<string, unknown>>) {
  const writeReturns: Record<string, () => unknown> = {
    persons: () => ({ id: "new-person-id" }),
    trip_members: () => ({ id: "new-member-id" }),
  };
  const readData: Record<string, Array<Record<string, unknown>>> = {
    trips: [{ id: TRIP_ID, skipper_id: SKIPPER_ID }],
    trip_members: [
      {
        id: OLD_MEMBER_ROW_ID,
        trip_id: TRIP_ID,
        person_id: OLD_PERSON_ID,
        on_board_from: null,
        on_board_to: null,
        is_alcoholic: null,
        note: null,
      },
      {
        id: EXISTING_MEMBER_ROW_ID,
        trip_id: TRIP_ID,
        person_id: EXISTING_MEMBER_PERSON_ID,
        on_board_from: null,
        on_board_to: null,
        is_alcoholic: null,
        note: null,
      },
    ],
    prepayment_obligations: [
      { trip_id: TRIP_ID, person_id: OLD_PERSON_ID, cabin_type_id: CABIN_ID, total_amount: 675 },
    ],
    persons_private: [{ person_id: EXISTING_MEMBER_PERSON_ID, email: "existing@example.com" }],
    transactions: transactionsRows,
  };

  const make = (table: string) => {
    let mode: "select" | "insert" | "upsert" | "update" | "delete" | null = null;
    let rows = [...(readData[table] ?? [])];
    const b: Record<string, unknown> = {};
    b.select = () => {
      if (mode === null) mode = "select";
      return b;
    };
    b.eq = (col: string, val: unknown) => {
      if (mode === "select") rows = rows.filter((r) => r[col] === val);
      return b;
    };
    b.not = (col: string) => {
      if (mode === "select") rows = rows.filter((r) => r[col] !== null && r[col] !== undefined);
      return b;
    };
    b.is = (col: string, val: unknown) => {
      if (mode === "select") {
        rows = rows.filter((r) => (val === null ? r[col] === null || r[col] === undefined : r[col] === val));
      }
      return b;
    };
    b.insert = (payload: unknown) => {
      mode = "insert";
      calls.push({ table, op: "insert", payload });
      return b;
    };
    b.upsert = (payload: unknown) => {
      mode = "upsert";
      calls.push({ table, op: "upsert", payload });
      return b;
    };
    b.update = (payload: unknown) => {
      mode = "update";
      calls.push({ table, op: "update", payload });
      return b;
    };
    b.delete = () => {
      mode = "delete";
      calls.push({ table, op: "delete" });
      return b;
    };
    b.maybeSingle = () => Promise.resolve(mode === "select" ? { data: rows[0] ?? null } : { data: null });
    b.single = () =>
      Promise.resolve(
        mode === "insert" || mode === "upsert"
          ? { data: writeReturns[table]?.() ?? { id: "unknown" }, error: null }
          : { data: rows[0] ?? null, error: rows[0] ? null : { message: "not found" } },
      );
    b.then = (onFulfilled: (v: unknown) => unknown) => {
      const value =
        mode === "select" || mode === null
          ? { data: rows, error: null, count: rows.length }
          : { data: null, error: null };
      return Promise.resolve(value).then(onFulfilled);
    };
    return b;
  };
  return { from: (table: string) => make(table) };
}

function replaceFormData(extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("trip_id", TRIP_ID);
  fd.set("old_person_id", OLD_PERSON_ID);
  fd.set("new_display_name", "Nachfolger");
  fd.set("new_email", "");
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

describe("replaceMember", () => {
  beforeEach(() => {
    mockedPerson.mockReset();
    mockedAuth.mockReset();
    mockedAdminClient.mockReset();
    mockedPerson.mockResolvedValue({ id: ACTOR_ID, display_name: "Skipper" } as never);
    mockedAuth.mockResolvedValue({ ok: true, personId: ACTOR_ID } as never);
  });

  it("übernimmt die bestätigte Zahlung, wenn keine offene Selbstmeldung existiert", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(makeSupabase(calls, [CONFIRMED_PAYMENT]) as never);

    const res = await replaceMember({ status: "idle" }, replaceFormData());
    expect(res).toEqual({ status: "ok" });

    const transferInserts = calls.filter((c) => c.table === "transactions" && c.op === "insert");
    expect(transferInserts).toHaveLength(1);
    expect((transferInserts[0].payload as { amount: number }).amount).toBe(202.5);
  });

  it("blockt den Wechsel, solange eine unbestätigte Selbstmeldung offen ist (statt sie zu übernehmen oder zu verwerfen)", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(makeSupabase(calls, [CONFIRMED_PAYMENT, PENDING_SELF_REPORT]) as never);

    const res = await replaceMember({ status: "idle" }, replaceFormData());
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toMatch(/unbestätigte/i);

    // Kein Zahlungsübertrag UND keine sonstige Schreib-Operation darf
    // vor dem Guard passiert sein — alles-oder-nichts, kein Teilzustand.
    expect(calls.filter((c) => c.table === "transactions" && c.op === "insert")).toHaveLength(0);
    expect(calls.filter((c) => c.table === "prepayment_obligations")).toHaveLength(0);
  });

  it("lehnt eine E-Mail ab, die schon zu einem ANDEREN Crewmitglied dieses Törns gehört, statt dessen Daten zu überschreiben", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(makeSupabase(calls, [CONFIRMED_PAYMENT]) as never);

    const res = await replaceMember(
      { status: "idle" },
      replaceFormData({ new_email: "existing@example.com", new_display_name: "" }),
    );
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toMatch(/bereits.*Crewmitglied/i);

    // Insbesondere: keine neue Person angelegt, kein trip_members-Upsert,
    // die bestehende Person wurde NICHT stillschweigend übernommen.
    expect(calls.filter((c) => c.table === "persons")).toHaveLength(0);
    expect(calls.filter((c) => c.table === "trip_members" && c.op === "upsert")).toHaveLength(0);
  });
});
