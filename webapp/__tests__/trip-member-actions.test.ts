// Regression zu Fund 4 + Fund 6 (Code-Review 2026-08):
// removeMember/setSkipperRole lasen und schrieben ihre trip_members-Zeile
// bisher NUR über `.eq("id", memberId)`, ohne `.eq("trip_id", tripId)` —
// ein Skipper von Törn A konnte damit über eine per RLS lesbare fremde
// trip_members.id (Törn B) dort Mitgliedschaften löschen bzw. is_skipper
// setzen. Da createAdminClient() den Service-Role-Client liefert (RLS
// umgangen), ist die einzige Sicherung, dass der App-Code selbst
// `.eq("trip_id", tripId)` an JEDER Stelle mitführt — genau das prüfen
// diese Tests, indem sie die tatsächlichen Query-Builder-Aufrufe erfassen.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/authz", () => ({
  requireSkipperOrAdmin: vi.fn(),
}));

import { removeMember, setSkipperRole, updateMember } from "@/lib/actions/trip-members";
import { requireSkipperOrAdmin } from "@/lib/auth/authz";
import { createAdminClient } from "@/lib/supabase/admin";

const mockedRequireSkipperOrAdmin = vi.mocked(requireSkipperOrAdmin);
const mockedAdminClient = vi.mocked(createAdminClient);

const TRIP_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const PERSON_ID = "aaaaaaaa-0000-4000-8000-000000000003";
const MEMBER_ID = "aaaaaaaa-0000-4000-8000-000000000004";

type Call = { table: string; method: string; args: unknown[] };

/**
 * Generischer Supabase-Mock, der jeden Query-Builder-Aufruf (Tabelle,
 * Methode, Argumente) protokolliert — so lässt sich direkt prüfen, ob der
 * Code tatsächlich `.eq("trip_id", tripId)` mitführt, statt nur ein
 * plausibles Endergebnis zu simulieren.
 */
function makeTripMemberSupabase(opts: {
  tripRow?: { skipper_id: string } | null;
  memberRow?: { person_id: string } | null;
  txCount?: number;
  participantCount?: number;
}) {
  const { tripRow = null, memberRow = null, txCount = 0, participantCount = 0 } = opts;
  const calls: Call[] = [];
  const make = (table: string) => {
    let counting = false;
    const b: Record<string, unknown> = {};
    const record =
      (method: string) =>
      (...args: unknown[]) => {
        calls.push({ table, method, args });
        return b;
      };
    b.select = (...args: unknown[]) => {
      calls.push({ table, method: "select", args });
      const options = args[1] as { count?: string } | undefined;
      if (options?.count) counting = true;
      return b;
    };
    b.eq = record("eq");
    b.is = record("is");
    b.or = record("or");
    b.update = record("update");
    b.delete = record("delete");
    b.insert = () => Promise.resolve({ error: null }); // logAudit
    b.maybeSingle = () => {
      if (table === "trips") return Promise.resolve({ data: tripRow });
      if (table === "trip_members") return Promise.resolve({ data: memberRow });
      return Promise.resolve({ data: null });
    };
    b.then = (onFulfilled: (v: unknown) => unknown) => {
      let value: unknown = { error: null };
      if (table === "transactions" && counting) value = { count: txCount };
      if (table === "transaction_participants" && counting) value = { count: participantCount };
      return Promise.resolve(value).then(onFulfilled);
    };
    return b;
  };
  return { supabase: { from: (table: string) => make(table) }, calls };
}

function hasEqCall(calls: Call[], table: string, col: string, val: unknown): boolean {
  return calls.some((c) => c.table === table && c.method === "eq" && c.args[0] === col && c.args[1] === val);
}

describe("removeMember — trip_id-Filter + transaction_participants-Check (Fund 4 + 6)", () => {
  beforeEach(() => {
    mockedRequireSkipperOrAdmin.mockReset();
    mockedAdminClient.mockReset();
    mockedRequireSkipperOrAdmin.mockResolvedValue({ ok: true, personId: OWNER_ID });
  });

  it("scoped Member-Lookup UND Delete auf trip_id (Fund 4)", async () => {
    const { supabase, calls } = makeTripMemberSupabase({
      tripRow: { skipper_id: OWNER_ID },
      memberRow: { person_id: PERSON_ID },
      txCount: 0,
      participantCount: 0,
    });
    mockedAdminClient.mockReturnValue(supabase as never);

    const res = await removeMember(MEMBER_ID, TRIP_ID);

    expect(res.ok).toBe(true);
    // Vor dem Fix gab es KEINEN .eq("trip_id", …)-Aufruf auf trip_members —
    // memberId allein war der (fremde Törns nicht ausschließende) Schlüssel.
    expect(hasEqCall(calls, "trip_members", "trip_id", TRIP_ID)).toBe(true);
    expect(calls.some((c) => c.table === "trip_members" && c.method === "delete")).toBe(true);
  });

  it("lehnt das Entfernen ab, wenn die Person nur über transaction_participants beteiligt ist (Fund 6)", async () => {
    // paid_by/credit_from/credit_to sind alle leer (txCount=0) — die Person
    // ist NUR als individual/per_person-Teilnehmerin an einer Buchung
    // beteiligt. Vor dem Fix griff dieser Blocker nicht, die Person konnte
    // entfernt werden und der Anteil blieb als unallokierter Rest stehen.
    const { supabase } = makeTripMemberSupabase({
      tripRow: { skipper_id: OWNER_ID },
      memberRow: { person_id: PERSON_ID },
      txCount: 0,
      participantCount: 1,
    });
    mockedAdminClient.mockReturnValue(supabase as never);

    const res = await removeMember(MEMBER_ID, TRIP_ID);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("noch Buchungen");
  });

  it("entfernt die Person weiterhin, wenn sie an keiner Buchung mehr beteiligt ist", async () => {
    const { supabase } = makeTripMemberSupabase({
      tripRow: { skipper_id: OWNER_ID },
      memberRow: { person_id: PERSON_ID },
      txCount: 0,
      participantCount: 0,
    });
    mockedAdminClient.mockReturnValue(supabase as never);

    const res = await removeMember(MEMBER_ID, TRIP_ID);
    expect(res.ok).toBe(true);
  });
});

describe("setSkipperRole — trip_id-Filter (Fund 4)", () => {
  beforeEach(() => {
    mockedRequireSkipperOrAdmin.mockReset();
    mockedAdminClient.mockReset();
    mockedRequireSkipperOrAdmin.mockResolvedValue({ ok: true, personId: OWNER_ID });
  });

  it("scoped Member-Lookup UND Update auf trip_id", async () => {
    const { supabase, calls } = makeTripMemberSupabase({
      tripRow: { skipper_id: OWNER_ID },
      memberRow: { person_id: PERSON_ID },
    });
    mockedAdminClient.mockReturnValue(supabase as never);

    await setSkipperRole(MEMBER_ID, TRIP_ID, true);

    // Vor dem Fix konnte über eine fremde trip_members.id (anderer Törn) die
    // Skipper-Rolle dort gesetzt werden — memberId allein war der Schlüssel.
    expect(hasEqCall(calls, "trip_members", "trip_id", TRIP_ID)).toBe(true);
    expect(
      calls.some((c) => c.table === "trip_members" && c.method === "update" && (c.args[0] as { is_skipper?: boolean })?.is_skipper === true),
    ).toBe(true);
  });
});

describe("updateMember — Ghost-Merge lehnt Törn-übergreifende Mitgliedschaft ab (Fund 5)", () => {
  const GHOST_ID = "aaaaaaaa-0000-4000-8000-000000000005";
  const REAL_ID = "aaaaaaaa-0000-4000-8000-000000000006";
  const NEW_EMAIL = "real-person@example.de";

  /**
   * Streng positionelles Skript: jeder Aufruf von `.maybeSingle()` ODER
   * `.then()` (je nachdem, was der reale Code für diese Query nutzt)
   * konsumiert den NÄCHSTEN Eintrag — unabhängig davon, welche der beiden
   * Terminal-Methoden greift. `.insert()` (logAudit) ist immer erfolgreich
   * und verbraucht KEINEN Skript-Slot, da Audit-Schreiben nicht Teil des
   * getesteten Kontrollflusses ist.
   */
  function makeScriptedSupabase(script: Array<{ table: string; response: unknown }>) {
    let idx = 0;
    const consume = (table: string) => {
      const entry = script[idx];
      if (!entry) throw new Error(`Kein Script-Eintrag für Aufruf #${idx + 1} (table=${table})`);
      idx += 1;
      if (entry.table !== table) {
        throw new Error(`Erwartete Tabelle "${entry.table}" an Position ${idx}, bekam "${table}"`);
      }
      return entry.response;
    };
    const make = (table: string) => {
      const b: Record<string, unknown> = {};
      const self = () => b;
      b.select = self;
      b.eq = self;
      b.neq = self;
      b.ilike = self;
      b.update = self;
      b.upsert = self;
      b.insert = () => Promise.resolve({ error: null });
      b.maybeSingle = () => Promise.resolve(consume(table));
      b.then = (onFulfilled: (v: unknown) => unknown) => Promise.resolve(consume(table)).then(onFulfilled);
      return b;
    };
    return { from: (table: string) => make(table) };
  }

  function updateMemberFormData(): FormData {
    const fd = new FormData();
    fd.set("member_id", MEMBER_ID);
    fd.set("trip_id", TRIP_ID);
    fd.set("email", NEW_EMAIL);
    return fd;
  }

  beforeEach(() => {
    mockedRequireSkipperOrAdmin.mockReset();
    mockedAdminClient.mockReset();
    mockedRequireSkipperOrAdmin.mockResolvedValue({ ok: true, personId: OWNER_ID });
  });

  it("lehnt den Merge ab, wenn der Ghost Mitglied eines anderen Törns ist", async () => {
    // Exakte Aufruf-Reihenfolge in updateMember → mergeGhostIntoExistingPerson
    // für den Zweig "Ghost bekommt eine E-Mail nachgetragen, die schon zu
    // einem ANDEREN Ghost gehört (auto-mergebar), der aber in einem fremden
    // Törn Crew ist":
    const supabase = makeScriptedSupabase([
      // 1. Member-Lookup (Ghost, kein auth_user_id)
      { table: "trip_members", response: { data: { person_id: GHOST_ID, persons: { auth_user_id: null } } } },
      // 2. trip_members-Felder-Update (on_board_from/to, is_alcoholic, note)
      { table: "trip_members", response: { error: null } },
      // 3. persons_private: bisherige E-Mail des Ghosts (isFirstEmail-Check)
      { table: "persons_private", response: { data: null } },
      // 4. persons_private: gehört NEW_EMAIL schon zu einer anderen Person?
      //    Ja — REAL_ID, ebenfalls ein Ghost (auth_user_id null, sonst
      //    würde der Consent-Schutz vorher schon abbrechen).
      {
        table: "persons_private",
        response: { data: { person_id: REAL_ID, persons: { display_name: "Real Person", auth_user_id: null } } },
      },
      // 5. mergeGhostIntoExistingPerson: ist REAL_ID schon Crew DIESES Törns? Nein.
      { table: "trip_members", response: { data: null } },
      // 6. NEUER Pre-Check (Fund 5): ist der Ghost Crew eines ANDEREN Törns? Ja.
      { table: "trip_members", response: { count: 1 } },
    ]);
    mockedAdminClient.mockReturnValue(supabase as never);

    const res = await updateMember({ status: "idle" }, updateMemberFormData());

    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.message).toContain("anderen Törn");
    }
  });
});
