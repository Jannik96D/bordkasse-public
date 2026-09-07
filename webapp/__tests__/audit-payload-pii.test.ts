// Sanierungsplan 2026-09, PR 7 (Purge/DSGVO), Punkt 4: Audit-Log-Payloads
// dürfen KEINE E-Mail-Adressen oder Anzeigenamen mehr im Klartext tragen —
// nur noch neutrale Flags/Kennzahlen. audit_log ist als Append-only-Log
// konzipiert (keine automatische Löschung außer den 90-Tage-Ausnahmen für
// verwaiste Törns, siehe supabase/migrations/0054), Klartext-PII darin wäre
// eine dauerhafte, unbegrenzt haltbare Kopie personenbezogener Daten.
//
// Diese Tests decken die drei Call-Sites ab, die vor dem Fix tatsächlich
// PII im Payload trugen:
//   1. lib/actions/trip-members.ts:updateMember — persons-UPDATE
//      (Anzeigename einer Ghost-Person)
//   2. lib/actions/trip-members.ts:updateMember — persons_private-UPDATE
//      (E-Mail-Adresse einer Ghost-Person)
//   3. lib/actions/trips.ts:createTrip — trips-INSERT
//      (created_for_skipper_email trug die volle E-Mail-Adresse)
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map()) }));
vi.mock("@/lib/auth/origin", () => ({ resolveOrigin: vi.fn(() => "https://bordkasse.dieter.ms") }));
vi.mock("@/lib/auth/invite", () => ({ sendInvitationMagicLink: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/authz", () => ({
  requireSkipperOrAdmin: vi.fn(),
  requireAdminOrTripCreator: vi.fn(),
  requireAdmin: vi.fn(),
  isAdmin: vi.fn(),
}));
vi.mock("@/lib/auth/get-current-person", () => ({ getCurrentPerson: vi.fn() }));

import { updateMember } from "@/lib/actions/trip-members";
import { createTrip } from "@/lib/actions/trips";
import { createCredit } from "@/lib/actions/transactions";
import { requireSkipperOrAdmin, requireAdminOrTripCreator, isAdmin } from "@/lib/auth/authz";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { createAdminClient } from "@/lib/supabase/admin";

const mockedRequireSkipperOrAdmin = vi.mocked(requireSkipperOrAdmin);
const mockedRequireAdminOrTripCreator = vi.mocked(requireAdminOrTripCreator);
const mockedIsAdmin = vi.mocked(isAdmin);
const mockedGetCurrentPerson = vi.mocked(getCurrentPerson);
const mockedAdminClient = vi.mocked(createAdminClient);

const TRIP_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const MEMBER_ID = "aaaaaaaa-0000-4000-8000-000000000004";
const GHOST_PERSON_ID = "aaaaaaaa-0000-4000-8000-000000000005";

type AuditInsertCall = { table_name: string; payload: unknown };

/**
 * Queued-Response-Mock: pro Tabelle eine FIFO-Warteschlange von Antworten,
 * konsumiert egal ob der Code `.maybeSingle()` aufruft oder die
 * Query-Builder-Kette selbst awaitet (`.then`). `audit_log`-Inserts werden
 * NICHT aus einer Queue bedient, sondern separat in `auditInserts`
 * aufgezeichnet — genau die Aufrufe, deren Payload wir prüfen wollen.
 */
function makeQueuedSupabase(queues: Record<string, unknown[]>) {
  const auditInserts: AuditInsertCall[] = [];
  const otherInsertCalls: Array<{ table: string; args: unknown[] }> = [];
  const consume = (table: string) => {
    const q = queues[table];
    if (!q || q.length === 0) {
      throw new Error(`Keine gescriptete Antwort mehr für Tabelle "${table}"`);
    }
    return q.shift();
  };
  const make = (table: string) => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    b.select = self;
    b.eq = self;
    b.neq = self;
    b.in = self;
    b.update = self;
    b.upsert = self;
    b.delete = self;
    b.insert = (...args: unknown[]) => {
      if (table === "audit_log") {
        const record = args[0] as AuditInsertCall;
        auditInserts.push({ table_name: record.table_name, payload: record.payload });
        // logAudit awaits the insert() call directly (no further chaining).
        return Promise.resolve({ error: null });
      }
      otherInsertCalls.push({ table, args });
      // Other insert() calls may be chained further (`.select().single()`)
      // or awaited directly — the builder itself is thenable via `b.then`.
      return b;
    };
    b.maybeSingle = () => Promise.resolve(consume(table));
    b.single = () => Promise.resolve(consume(table));
    b.then = (onFulfilled: (v: unknown) => unknown) => Promise.resolve(consume(table)).then(onFulfilled);
    return b;
  };
  return {
    supabase: {
      from: (table: string) => make(table),
      rpc: () => Promise.resolve({ error: null }),
    },
    auditInserts,
    otherInsertCalls,
  };
}

describe("Audit-Log-Payloads enthalten keine PII im Klartext mehr (Sanierungsplan PR 7, Punkt 4)", () => {
  beforeEach(() => {
    mockedRequireSkipperOrAdmin.mockReset();
    mockedRequireAdminOrTripCreator.mockReset();
    mockedIsAdmin.mockReset();
    mockedAdminClient.mockReset();
    mockedRequireSkipperOrAdmin.mockResolvedValue({ ok: true, personId: OWNER_ID });
  });

  it("updateMember: Anzeigename-Änderung loggt nur ein Flag, keinen Klartext-Namen", async () => {
    const { supabase, auditInserts } = makeQueuedSupabase({
      trips: [
        // assertTripNotArchived (Sanierungsplan D3) — erster Supabase-Aufruf
        // direkt nach dem Auth-Guard, vor dem Member-Lookup.
        { data: { archived: false } },
      ],
      trip_members: [
        // 1. Member-Lookup (Ghost, kein auth_user_id).
        { data: { person_id: GHOST_PERSON_ID, persons: { auth_user_id: null } } },
        // 2. trip_members-Felder-Update (on_board_from/to, is_alcoholic, note).
        { error: null },
      ],
      persons: [
        // persons-UPDATE({ display_name }).
        { error: null },
      ],
    });
    mockedAdminClient.mockReturnValue(supabase as never);

    const fd = new FormData();
    fd.set("member_id", MEMBER_ID);
    fd.set("trip_id", TRIP_ID);
    fd.set("display_name", "Max Mustermann");
    fd.set("email", "");

    const res = await updateMember({ status: "idle" }, fd);
    expect(res.status).toBe("ok");

    const personsAudit = auditInserts.find((a) => a.table_name === "persons");
    expect(personsAudit).toBeDefined();
    expect(personsAudit!.payload).toEqual({ name_changed: true });

    const serialized = JSON.stringify(auditInserts);
    expect(serialized).not.toContain("Max Mustermann");
    expect(serialized).not.toContain("display_name");
  });

  it("updateMember: E-Mail-Änderung loggt nur ein Flag, keine Klartext-Adresse", async () => {
    const { supabase, auditInserts } = makeQueuedSupabase({
      trips: [
        // assertTripNotArchived (Sanierungsplan D3).
        { data: { archived: false } },
      ],
      trip_members: [
        // 1. Member-Lookup (Ghost, kein auth_user_id).
        { data: { person_id: GHOST_PERSON_ID, persons: { auth_user_id: null } } },
        // 2. trip_members-Felder-Update.
        { error: null },
      ],
      persons_private: [
        // a. bisherige E-Mail des Ghosts (isFirstEmail-Check) — noch keine.
        { data: null },
        // b. gehört die neue E-Mail schon einer anderen Person? Nein.
        { data: null, error: null },
        // c. upsert({ person_id, email }).
        { error: null },
      ],
    });
    mockedAdminClient.mockReturnValue(supabase as never);

    const fd = new FormData();
    fd.set("member_id", MEMBER_ID);
    fd.set("trip_id", TRIP_ID);
    fd.set("display_name", "");
    fd.set("email", "geheim@example.de");

    const res = await updateMember({ status: "idle" }, fd);
    expect(res.status).toBe("ok");

    const privAudit = auditInserts.find((a) => a.table_name === "persons_private");
    expect(privAudit).toBeDefined();
    expect(privAudit!.payload).toEqual({ email_changed: true });

    const serialized = JSON.stringify(auditInserts);
    expect(serialized).not.toContain("geheim@example.de");
    expect(serialized).not.toContain("\"email\"");
  });

  it("createTrip: Audit-Payload trägt nur ein Boolean-Flag, keine Klartext-Skipper-E-Mail", async () => {
    mockedRequireAdminOrTripCreator.mockResolvedValue({ ok: true, personId: OWNER_ID });
    mockedIsAdmin.mockResolvedValue(true);

    const tripRow = {
      id: TRIP_ID,
      name: "Ostseetörn",
      start_date: "2026-06-01",
      end_date: "2026-06-10",
      trip_type: "sailing",
      skipper_id: "aaaaaaaa-0000-4000-8000-000000000009",
    };

    const { supabase, auditInserts } = makeQueuedSupabase({
      persons_private: [
        // Skipper-E-Mail-Lookup (existingPriv) — nicht gefunden, neuer Ghost.
        { data: null, error: null },
        // persons_private-INSERT({ person_id, email }) für den neuen Ghost.
        { error: null },
      ],
      persons: [
        // neue Ghost-Person für den Skipper anlegen.
        { data: { id: "aaaaaaaa-0000-4000-8000-000000000009" }, error: null },
      ],
      trips: [
        // trips-INSERT().select().single().
        { data: tripRow, error: null },
      ],
      trip_members: [{ error: null }],
      trip_categories: [{ error: null }],
    });
    mockedAdminClient.mockReturnValue(supabase as never);

    const fd = new FormData();
    fd.set("name", "Ostseetörn");
    fd.set("start_date", "2026-06-01");
    fd.set("end_date", "2026-06-10");
    fd.set("skipper_email", "skipper@example.de");

    await expect(createTrip({ status: "idle" }, fd)).rejects.toThrow("NEXT_REDIRECT");

    const tripsAudit = auditInserts.find((a) => a.table_name === "trips");
    expect(tripsAudit).toBeDefined();
    const payload = tripsAudit!.payload as Record<string, unknown>;
    expect(payload.created_for_skipper_email_provided).toBe(true);
    expect(payload).not.toHaveProperty("created_for_skipper_email");

    const serialized = JSON.stringify(auditInserts);
    expect(serialized).not.toContain("skipper@example.de");
  });

  it("createCredit: Audit-Payload trägt keine Klartext-Beschreibung (Grill-Review-Fund, Fund 4)", async () => {
    // Gutschrift-Beschreibungen nennen systematisch Namen im Klartext
    // ("Crewwechsel: X übernimmt Anzahlung für Y") — dieselbe Begründung,
    // aus der Migration 0054 (D5) description beim Purge nur bei
    // Gutschriften nullt. Der Audit-Log-Eintrag darf diesen Klartext nicht
    // unbegrenzt weitertragen.
    mockedGetCurrentPerson.mockResolvedValue({ id: OWNER_ID } as never);
    mockedRequireSkipperOrAdmin.mockResolvedValue({ ok: true, personId: OWNER_ID });

    const CREDIT_TO_ID = "aaaaaaaa-0000-4000-8000-000000000006";
    const { supabase, auditInserts } = makeQueuedSupabase({
      trips: [
        // assertTripNotArchived (Sanierungsplan D3) — läuft direkt nach
        // requireSkipperOrAdmin, vor der "An Alle"-Crewgrößen-Prüfung.
        { data: { archived: false } },
      ],
      trip_members: [
        // personsBelongToTrip(credit_from, credit_to).
        { data: [{ person_id: OWNER_ID }, { person_id: CREDIT_TO_ID }], error: null },
      ],
      transactions: [
        // INSERT().select("id").single().
        { data: { id: "aaaaaaaa-0000-4000-8000-000000000007" }, error: null },
      ],
    });
    mockedAdminClient.mockReturnValue(supabase as never);

    const fd = new FormData();
    fd.set("trip_id", TRIP_ID);
    fd.set("date", "2026-06-05");
    fd.set("description", "Crewwechsel: Max Mustermann übernimmt Anzahlung für Lucas Schmidt");
    fd.set("amount", "100");
    fd.set("credit_from", OWNER_ID);
    fd.set("credit_to", CREDIT_TO_ID);

    await expect(createCredit({ status: "idle" }, fd)).rejects.toThrow("NEXT_REDIRECT");

    const txAudit = auditInserts.find((a) => a.table_name === "transactions");
    expect(txAudit).toBeDefined();
    expect(txAudit!.payload).not.toHaveProperty("description");

    const serialized = JSON.stringify(auditInserts);
    expect(serialized).not.toContain("Max Mustermann");
    expect(serialized).not.toContain("Lucas Schmidt");
  });
});
