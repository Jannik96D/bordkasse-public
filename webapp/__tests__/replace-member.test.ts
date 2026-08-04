// replaceMember (Crewwechsel A → B) — Regressionen für die beim
// UI-Anbinden und beim anschließenden Idempotenz-Fix (Fund 3) gefundenen
// Bugs (lib/actions/prepayments.ts):
//  1. Der Payment-Transfer-Query filterte nicht auf confirmed_at, hätte
//     also eine unbestätigte Selbstmeldung wie eine echte Zahlung
//     übernommen.
//  2. Der Pre-Check auf eine offene Selbstmeldung muss vor JEDER
//     Schreib-Operation laufen — sonst hinterlässt ein abgelehnter Wechsel
//     trotzdem schon eine Ghost-Person + Creweintrag (Orphan).
//  3. Eine new_email, die schon zu einem ANDEREN Crewmitglied desselben
//     Törns gehört, hätte dessen trip_members-/Obligation-Zeile
//     stillschweigend überschrieben statt abzulehnen.
//  4. Idempotenz (Grill-Review, Fund 3): Netzwerk-Retry (flakey Yacht-WLAN)
//     durfte weder die neue Person noch den Zahlungstransfer duplizieren.
//     Der Zahlungstransfer nutzt dafür `idempotency_key = p.id` (die ID der
//     QUELL-Zahlung) statt eines Check-before-Insert auf Betrag+Datum — ein
//     früherer Ansatz hätte zwei unterschiedliche, gleich hohe Zahlungen
//     vom selben Tag verwechselt und eine davon verschluckt (Geld
//     verschwindet aus der Bilanz, siehe Test "verwechselt NICHT ...").
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

// Postgres unique_violation — dieselbe Zahl wie PG_UNIQUE_VIOLATION in
// lib/actions/prepayments.ts (dort nicht exportiert, daher hier dupliziert).
const PG_UNIQUE_VIOLATION = "23505";

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
const NEW_PERSON_ID = "aaaaaaaa-0000-4000-8000-00000000000a";

const CONFIRMED_PAYMENT = {
  id: "aaaaaaaa-0000-4000-8000-0000000000c1",
  trip_id: TRIP_ID,
  credit_from: OLD_PERSON_ID,
  type: "credit",
  tranche_id: TRANCHE_ID,
  deleted_at: null,
  confirmed_at: "2026-08-01T10:00:00Z",
  amount: 202.5,
  date: "2026-08-01",
};

// Zweite, UNABHÄNGIGE Zahlung mit exakt demselben Betrag + Datum wie
// CONFIRMED_PAYMENT (z.B. zwei gleich große Tranchen, am selben Tag
// bestätigt) — der Regressionsfall für Fund 1 aus dem Grill-Review.
const CONFIRMED_PAYMENT_SAME_AMOUNT_AND_DATE = {
  ...CONFIRMED_PAYMENT,
  id: "aaaaaaaa-0000-4000-8000-0000000000c2",
  tranche_id: "aaaaaaaa-0000-4000-8000-0000000000c3",
};

const PENDING_SELF_REPORT = {
  id: "aaaaaaaa-0000-4000-8000-0000000000c9",
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
 * kanonischen Zeilen im "select"-Modus wirklich. `transactions`-Inserts mit
 * einem `idempotency_key` simulieren die reale UNIQUE(trip_id,
 * idempotency_key)-Verletzung (0005_idempotency.sql), statt sie zu ignorieren
 * — sonst könnte der Test nicht unterscheiden, ob der Code einen Retry
 * tatsächlich abfängt oder nur zufällig kein zweites Mal versucht.
 */
function makeSupabase(calls: Call[], transactionsRows: Array<Record<string, unknown>>) {
  const writeReturns: Record<string, (payload: unknown) => unknown> = {
    persons: (payload) => ({ id: (payload as { id?: string })?.id ?? "new-person-id" }),
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
    persons: [{ id: NEW_PERSON_ID, auth_user_id: null }],
    transactions: transactionsRows,
  };

  // UNIQUE(trip_id, idempotency_key) — vorbelegt mit den idempotency_keys
  // aus den kanonischen Zeilen (simuliert "schon vorher erfolgreich
  // eingefügt"), wächst während des Tests mit jedem echten Insert.
  const usedIdempotencyKeys = new Set(
    transactionsRows.filter((r) => r.idempotency_key).map((r) => String(r.idempotency_key)),
  );

  const make = (table: string) => {
    let mode: "select" | "insert" | "upsert" | "update" | "delete" | null = null;
    let rows = [...(readData[table] ?? [])];
    let lastPayload: unknown;
    let insertError: { code: string; message: string } | null = null;
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
      lastPayload = payload;
      calls.push({ table, op: "insert", payload });
      if (table === "transactions") {
        const key = (payload as { idempotency_key?: string })?.idempotency_key;
        if (key) {
          if (usedIdempotencyKeys.has(key)) {
            insertError = { code: PG_UNIQUE_VIOLATION, message: "duplicate key value violates unique constraint" };
          } else {
            usedIdempotencyKeys.add(key);
          }
        }
      }
      return b;
    };
    b.upsert = (payload: unknown) => {
      mode = "upsert";
      lastPayload = payload;
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
          ? { data: insertError ? null : writeReturns[table]?.(lastPayload) ?? { id: "unknown" }, error: insertError }
          : { data: rows[0] ?? null, error: rows[0] ? null : { message: "not found" } },
      );
    b.then = (onFulfilled: (v: unknown) => unknown) => {
      const value =
        mode === "select" || mode === null
          ? { data: rows, error: null, count: rows.length }
          : { data: null, error: insertError };
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
  fd.set("new_person_id", NEW_PERSON_ID);
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
    const payload = transferInserts[0].payload as { amount: number; idempotency_key: string };
    expect(payload.amount).toBe(202.5);
    // idempotency_key = ID der QUELL-Zahlung (nicht new_person_id) — das
    // ist die eigentliche Fund-3-Garantie, siehe Testdatei-Kopfkommentar.
    expect(payload.idempotency_key).toBe(CONFIRMED_PAYMENT.id);
  });

  it("verwechselt NICHT zwei unterschiedliche Zahlungen mit gleichem Betrag+Datum (Fund 1, Grill-Review)", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(
      makeSupabase(calls, [CONFIRMED_PAYMENT, CONFIRMED_PAYMENT_SAME_AMOUNT_AND_DATE]) as never,
    );

    const res = await replaceMember({ status: "idle" }, replaceFormData());
    expect(res).toEqual({ status: "ok" });

    const transferInserts = calls.filter((c) => c.table === "transactions" && c.op === "insert");
    expect(transferInserts).toHaveLength(2);
    const keys = transferInserts.map((c) => (c.payload as { idempotency_key: string }).idempotency_key);
    expect(new Set(keys).size).toBe(2); // beide Transfers eigenständig, keiner verschluckt
    expect(keys.sort()).toEqual([CONFIRMED_PAYMENT.id, CONFIRMED_PAYMENT_SAME_AMOUNT_AND_DATE.id].sort());
  });

  it("Fund 3 (Idempotency): verhindert einen doppelten Zahlungstransfer bei Retry mit gleicher new_person_id", async () => {
    // Simuliert den Zustand NACH einem bereits erfolgreichen ersten Versuch:
    // eine Transfer-Zeile mit idempotency_key = CONFIRMED_PAYMENT.id existiert
    // schon (genau der Key, den ein Retry erneut verwenden würde).
    const existingTransfer = {
      id: "aaaaaaaa-0000-4000-8000-0000000000c8",
      trip_id: TRIP_ID,
      type: "credit",
      credit_from: NEW_PERSON_ID,
      credit_to: OLD_PERSON_ID,
      tranche_id: null,
      amount: CONFIRMED_PAYMENT.amount,
      date: CONFIRMED_PAYMENT.date,
      deleted_at: null,
      confirmed_at: null,
      idempotency_key: CONFIRMED_PAYMENT.id,
    };
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(makeSupabase(calls, [CONFIRMED_PAYMENT, existingTransfer]) as never);

    const res = await replaceMember({ status: "idle" }, replaceFormData());
    // Die Unique-Violation wird abgefangen (wie insertCredit/recordPayment) —
    // der Retry ist ein No-Op, kein Fehler.
    expect(res).toEqual({ status: "ok" });

    // Der Code versucht den Insert erneut (das ist korrekt — er weiß vorher
    // nicht, dass er schon passiert ist), aber es darf am Ende trotzdem nur
    // GENAU EINE Zeile mit diesem idempotency_key in der (simulierten) DB
    // existieren — die reale UNIQUE-Constraint garantiert das.
    const transferAttempts = calls.filter(
      (c) =>
        c.table === "transactions" &&
        c.op === "insert" &&
        (c.payload as { idempotency_key?: string }).idempotency_key === CONFIRMED_PAYMENT.id,
    );
    expect(transferAttempts).toHaveLength(1);
  });

  it("blockt den Wechsel, solange eine unbestätigte Selbstmeldung offen ist — VOR jeder Schreib-Operation", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(makeSupabase(calls, [CONFIRMED_PAYMENT, PENDING_SELF_REPORT]) as never);

    const res = await replaceMember({ status: "idle" }, replaceFormData());
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toMatch(/unbestätigte/i);

    // Alles-oder-nichts: der Pre-Check muss vor der Personen-/Crew-Anlage
    // laufen, sonst bliebe bei einem Reject eine Ghost-Person + Creweintrag
    // als Orphan zurück (Grill-Review-Fund).
    expect(calls).toHaveLength(0);
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

  it("legt die neue Person mit der client-generierten ID an (upsert-by-id statt insert)", async () => {
    const calls: Call[] = [];
    mockedAdminClient.mockReturnValue(makeSupabase(calls, [CONFIRMED_PAYMENT]) as never);

    const res = await replaceMember({ status: "idle" }, replaceFormData());
    expect(res).toEqual({ status: "ok" });

    const personsUpserts = calls.filter((c) => c.table === "persons" && c.op === "upsert");
    expect(personsUpserts).toHaveLength(1);
    expect((personsUpserts[0].payload as { id: string }).id).toBe(NEW_PERSON_ID);
  });
});
