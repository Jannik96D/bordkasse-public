// Server-Action-Guards (Auth + Eingabe-Validierung) ohne DB/Request-Kontext.
//
// Etabliert das Mock-Muster für Server-Actions: "server-only" + die Supabase-/
// Next-/Auth-Abhängigkeiten werden gemockt, sodass die früh greifenden Guards
// (nicht angemeldet, ungültige Eingabe) ohne echte DB getestet werden können.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/authz", () => ({
  requireMember: vi.fn(),
  requireSkipperOrAdmin: vi.fn(),
  requireSkipperAdminOrAdvancer: vi.fn(),
  isAdmin: vi.fn(),
}));
vi.mock("@/lib/auth/get-current-person", () => ({ getCurrentPerson: vi.fn() }));

import {
  createExpense,
  createCredit,
  updateCredit,
  deleteTransaction,
  replayPendingTransaction,
} from "@/lib/actions/transactions";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import {
  requireMember,
  requireSkipperOrAdmin,
  requireSkipperAdminOrAdvancer,
  isAdmin,
} from "@/lib/auth/authz";
import { createAdminClient } from "@/lib/supabase/admin";

const mockedPerson = vi.mocked(getCurrentPerson);
const mockedRequireMember = vi.mocked(requireMember);
const mockedRequireSkipperOrAdmin = vi.mocked(requireSkipperOrAdmin);
const mockedIsAdmin = vi.mocked(isAdmin);
const mockedAdvancer = vi.mocked(requireSkipperAdminOrAdvancer);
const mockedAdminClient = vi.mocked(createAdminClient);

// RFC-4122-valide Seed-UUIDs (Zod v4 .uuid() ist strikt: Version-Nibble 4,
// Variant-Bits 8) — sonst scheitert die Schema-Validierung vor dem Guard.
const TRIP_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const PERSON_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const TRANCHE_ID = "aaaaaaaa-0000-4000-8000-000000000003";

/**
 * Minimaler, chainbarer Supabase-Mock für den createExpense-Pfad bis zum
 * Tranche-Guard. `trip_members` antwortet im Count-Modus (checkMinShare) bzw.
 * Data-Modus (personsBelongToTrip), `prepayment_tranches` über maybeSingle
 * (trancheBelongsToTrip). Mehr braucht der Guard-Test nicht — er returnt
 * vor dem Insert.
 */
function makeSupabase(
  opts: {
    trancheBelongs?: boolean;
    foundPersonIds?: string[];
    memberWindows?: Array<{ person_id: string; on_board_from: string | null; on_board_to: string | null }>;
    tripDates?: { start_date: string; end_date: string; trip_type?: string };
  } = {},
) {
  const {
    trancheBelongs = true,
    foundPersonIds = [],
    memberWindows,
    tripDates = { start_date: "2026-06-06", end_date: "2026-06-13" },
  } = opts;
  const make = (table: string) => {
    let counting = false;
    const b: Record<string, unknown> = {};
    const self = () => b;
    b.select = (_cols?: unknown, options?: { count?: string }) => {
      if (options?.count) counting = true;
      return b;
    };
    b.eq = self;
    b.in = self;
    b.is = self;
    b.not = self;
    b.insert = self;
    b.maybeSingle = () =>
      Promise.resolve(
        table === "prepayment_tranches"
          ? { data: trancheBelongs ? { id: TRANCHE_ID } : null }
          : { data: null },
      );
    // checkOnBoardDate liest die Törn-Grenzen via .single() von `trips`.
    b.single = () =>
      Promise.resolve(table === "trips" ? { data: tripDates } : { data: null });
    // Thenable: erlaubt `await supabase.from(t).select().eq()` ohne Terminator.
    b.then = (onFulfilled: (v: unknown) => unknown) => {
      let value: unknown = { data: [], count: 0 };
      if (table === "trip_members") {
        value = counting
          ? { count: 5, data: null }
          : { data: memberWindows ?? foundPersonIds.map((person_id) => ({ person_id })) };
      }
      return Promise.resolve(value).then(onFulfilled);
    };
    return b;
  };
  return { from: (table: string) => make(table) };
}

function expenseFormData(extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("trip_id", TRIP_ID);
  fd.set("date", "2026-06-07");
  fd.set("description", "1. Anzahlung");
  fd.set("paid_by", PERSON_ID);
  fd.set("amount", "360,00");
  fd.set("split_type", "equal");
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

describe("createExpense — Auth- & Validierungs-Guards", () => {
  beforeEach(() => mockedPerson.mockReset());

  it("weist nicht angemeldete Nutzer ab (kein DB-Zugriff)", async () => {
    mockedPerson.mockResolvedValue(null);
    const res = await createExpense({ status: "idle" }, new FormData());
    expect(res).toEqual({ status: "error", message: "Nicht angemeldet." });
  });

  it("liefert Feldfehler bei ungültiger Eingabe, bevor die DB berührt wird", async () => {
    mockedPerson.mockResolvedValue({ id: "p1", display_name: "Test" } as never);
    const res = await createExpense({ status: "idle" }, new FormData());
    expect(res.status).toBe("error");
    if (res.status === "error") {
      // zodErrorState liefert Pro-Feld-Fehler → Formular kann sie anzeigen.
      expect(typeof res.fieldErrors).toBe("object");
    }
  });
});

describe("createCredit — Auth-Guard", () => {
  beforeEach(() => mockedPerson.mockReset());

  it("weist nicht angemeldete Nutzer ab", async () => {
    mockedPerson.mockResolvedValue(null);
    const res = await createCredit({ status: "idle" }, new FormData());
    expect(res).toEqual({ status: "error", message: "Nicht angemeldet." });
  });
});

describe("createExpense — Tranche-Zuordnung nur für Skipper/Admin/Vorstrecker", () => {
  beforeEach(() => {
    mockedPerson.mockReset();
    mockedRequireMember.mockReset();
    mockedAdvancer.mockReset();
    mockedAdminClient.mockReset();
    mockedPerson.mockResolvedValue({ id: PERSON_ID, display_name: "Crew", email: "c@x.de" } as never);
    mockedRequireMember.mockResolvedValue({ ok: true, personId: PERSON_ID });
  });

  it("weist eine tranche-zugeordnete Ausgabe ab, wenn der Nutzer nicht berechtigt ist", async () => {
    // Member (darf normale Buchungen), aber NICHT Skipper/Admin/Vorstrecker.
    mockedAdvancer.mockResolvedValue({ ok: false, message: "egal" });
    mockedAdminClient.mockReturnValue(makeSupabase({ trancheBelongs: true }) as never);

    const res = await createExpense({ status: "idle" }, expenseFormData({ tranche_id: TRANCHE_ID }));

    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toContain("Anzahlungstranche");
    // Der Rollen-Check muss tatsächlich für diesen Törn gelaufen sein.
    expect(mockedAdvancer).toHaveBeenCalledWith(TRIP_ID);
  });

  it("ruft den Tranche-Rollen-Check NICHT auf, wenn keine Tranche zugeordnet ist", async () => {
    // Normale Bordkasse-Buchung eines Crewmitglieds — der Advancer-Guard darf
    // sie nicht behindern. Wir lassen sie bewusst erst am Cross-Trip-Check
    // (leere Personenliste) enden, ohne den Insert-Pfad zu mocken.
    mockedAdvancer.mockResolvedValue({ ok: false, message: "egal" });
    mockedAdminClient.mockReturnValue(makeSupabase({ foundPersonIds: [] }) as never);

    const res = await createExpense({ status: "idle" }, expenseFormData());

    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).not.toContain("Anzahlungstranche");
    expect(mockedAdvancer).not.toHaveBeenCalled();
  });
});

describe("createExpense — Datum außerhalb des Törns", () => {
  beforeEach(() => {
    mockedPerson.mockReset();
    mockedRequireMember.mockReset();
    mockedAdvancer.mockReset();
    mockedAdminClient.mockReset();
    mockedPerson.mockResolvedValue({ id: PERSON_ID, display_name: "Crew", email: "c@x.de" } as never);
    mockedRequireMember.mockResolvedValue({ ok: true, personId: PERSON_ID });
    mockedAdminClient.mockReturnValue(makeSupabase({ foundPersonIds: [] }) as never);
  });

  it("weist „An Bord“ mit Vor-Törn-Datum ab (sonst bliebe die Ausgabe unallokiert)", async () => {
    const res = await createExpense(
      { status: "idle" },
      expenseFormData({ split_type: "on_board", date: "2026-05-01" }),
    );
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.field).toBe("date");
      expect(res.message).toContain("niemand an Bord");
    }
  });

  it('formuliert die Ablehnung bei „Andere Reise" segelneutral („Anwesend"/Reisezeitraum)', async () => {
    mockedAdminClient.mockReturnValue(
      makeSupabase({
        foundPersonIds: [],
        tripDates: { start_date: "2026-06-06", end_date: "2026-06-13", trip_type: "other" },
      }) as never,
    );
    const res = await createExpense(
      { status: "idle" },
      expenseFormData({ split_type: "on_board", date: "2026-05-01" }),
    );
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.message).toContain("niemand anwesend");
      expect(res.message).toContain("Anwesend");
      expect(res.message).toContain("Reisezeitraum");
      expect(res.message).not.toContain("an Bord");
    }
  });

  it("weist „An Bord“ mit Nach-Törn-Datum ebenso ab", async () => {
    const res = await createExpense(
      { status: "idle" },
      expenseFormData({ split_type: "on_board", date: "2026-07-01" }),
    );
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.field).toBe("date");
  });

  it("weist „An Bord“ mit In-Törn-Datum ab, wenn an dem Tag niemand an Bord ist (Fund C-1)", async () => {
    // Datum liegt im Törnzeitraum (06.–13.06.), aber die ganze Crew kommt erst
    // ab dem 09.06. an Bord → am 07.06. ist niemand da → Ausgabe bliebe
    // unallokiert (Bilanz-Summe ≠ 0). Muss abgelehnt werden.
    mockedAdminClient.mockReturnValue(
      makeSupabase({
        memberWindows: [{ person_id: PERSON_ID, on_board_from: "2026-06-09", on_board_to: "2026-06-13" }],
      }) as never,
    );
    const res = await createExpense(
      { status: "idle" },
      expenseFormData({ split_type: "on_board", date: "2026-06-07" }),
    );
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.field).toBe("date");
      expect(res.message).toContain("niemand an Bord");
    }
  });

  it("lässt „An Bord“ mit Datum im Törnzeitraum und Anwesenden durch den Datums-Guard", async () => {
    // Endet bewusst erst am Cross-Trip-Check (leere Personenliste) —
    // der Datums-Guard selbst darf nicht anschlagen.
    const res = await createExpense(
      { status: "idle" },
      expenseFormData({ split_type: "on_board", date: "2026-06-07" }),
    );
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.field).not.toBe("date");
  });

  it("erlaubt datumsunabhängige Aufteilungen vor dem Törn (Anzahlung, Versicherung)", async () => {
    // Gleichmäßig mit Vor-Törn-Datum passiert den Datums-Guard und endet
    // erst am Cross-Trip-Check — kein Datums-Feldfehler.
    const res = await createExpense(
      { status: "idle" },
      expenseFormData({ split_type: "equal", date: "2026-05-01" }),
    );
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.field).not.toBe("date");
      expect(res.message).toContain("gehört nicht zu diesem Törn");
    }
  });
});

describe("replayPendingTransaction — dieselben Guards wie createExpense (Fund S-1)", () => {
  beforeEach(() => {
    mockedPerson.mockReset();
    mockedRequireMember.mockReset();
    mockedAdminClient.mockReset();
    mockedPerson.mockResolvedValue({ id: PERSON_ID, display_name: "Crew", email: "c@x.de" } as never);
    mockedRequireMember.mockResolvedValue({ ok: true, personId: PERSON_ID });
  });

  it("weist eine Replay-Ausgabe mit trip-fremdem paid_by ab (Cross-Trip-Schutz)", async () => {
    // foundPersonIds leer → personsBelongToTrip schlägt fehl. Vor dem Fix lief
    // der Replay-Pfad ganz ohne diese Prüfung und hätte die fremde Person
    // in die Bilanz geschrieben.
    mockedAdminClient.mockReturnValue(makeSupabase({ foundPersonIds: [] }) as never);
    const res = await replayPendingTransaction("expense", {
      trip_id: TRIP_ID,
      date: "2026-06-07",
      description: "Offline-Ausgabe",
      paid_by: PERSON_ID,
      amount: "360,00",
      split_type: "equal",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("gehört nicht zu diesem Törn");
  });

  it('weist eine Replay-„An Bord"-Ausgabe außerhalb des Törnzeitraums ab', async () => {
    mockedAdminClient.mockReturnValue(makeSupabase({ foundPersonIds: [PERSON_ID] }) as never);
    const res = await replayPendingTransaction("expense", {
      trip_id: TRIP_ID,
      date: "2026-05-01",
      description: "Offline vor Törn",
      paid_by: PERSON_ID,
      amount: "360,00",
      split_type: "on_board",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("niemand an Bord");
  });
});

describe("updateCredit — Skipper/Admin-only, kein Ersteller-Recht (Fund 3)", () => {
  const CREDIT_FROM = "aaaaaaaa-0000-4000-8000-000000000004";
  const CREDIT_TO = "aaaaaaaa-0000-4000-8000-000000000005";
  const TX_ID = "aaaaaaaa-0000-4000-8000-00000000000e";
  const OTHER_TRANCHE_ID = "aaaaaaaa-0000-4000-8000-000000000006";

  /**
   * Supabase-Mock für updateCredit: `transactions` liefert beim ersten
   * .maybeSingle()-Aufruf `existing`, beim späteren .update() wird das
   * Payload eingefangen (`getCapturedUpdate`). `prepayment_tranches` und
   * `trip_members` bedienen trancheBelongsToTrip/personsBelongToTrip.
   */
  function makeUpdateCreditSupabase(opts: {
    existing: Record<string, unknown> | null;
    trancheBelongs?: boolean;
    memberIds?: string[];
  }) {
    const { existing, trancheBelongs = true, memberIds = [CREDIT_FROM, CREDIT_TO] } = opts;
    let capturedUpdate: Record<string, unknown> | null = null;
    const make = (table: string) => {
      const b: Record<string, unknown> = {};
      const self = () => b;
      b.select = self;
      b.eq = self;
      b.in = self;
      b.insert = () => Promise.resolve({ error: null }); // logAudit
      b.update = (payload: Record<string, unknown>) => {
        capturedUpdate = payload;
        return b;
      };
      b.maybeSingle = () => {
        if (table === "transactions") return Promise.resolve({ data: existing });
        if (table === "prepayment_tranches") {
          return Promise.resolve({ data: trancheBelongs ? { id: OTHER_TRANCHE_ID } : null });
        }
        return Promise.resolve({ data: null });
      };
      b.then = (onFulfilled: (v: unknown) => unknown) => {
        let value: unknown = { error: null };
        if (table === "trip_members") {
          value = { data: memberIds.map((person_id) => ({ person_id })) };
        }
        return Promise.resolve(value).then(onFulfilled);
      };
      return b;
    };
    return {
      supabase: {
        from: (table: string) => make(table),
        rpc: () => Promise.resolve({ error: null }), // markPostSettlementChange
      },
      getCapturedUpdate: () => capturedUpdate,
    };
  }

  function creditFormData(extra: Record<string, string> = {}): FormData {
    const fd = new FormData();
    fd.set("transaction_id", TX_ID);
    fd.set("trip_id", TRIP_ID);
    fd.set("date", "2026-06-07");
    fd.set("description", "Anzahlung");
    fd.set("amount", "150,00");
    fd.set("credit_from", CREDIT_FROM);
    fd.set("credit_to", CREDIT_TO);
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    return fd;
  }

  beforeEach(() => {
    mockedPerson.mockReset();
    mockedRequireSkipperOrAdmin.mockReset();
    mockedAdvancer.mockReset();
    mockedAdminClient.mockReset();
    mockedPerson.mockResolvedValue({ id: CREDIT_FROM, display_name: "Crew" } as never);
  });

  it("weist den Ersteller einer Gutschrift ab, der nicht Skipper/Admin ist (submitSelfPayment-Missbrauch)", async () => {
    // Genau das Szenario aus Fund 3: die Person hat die Gutschrift selbst
    // erstellt (z. B. per submitSelfPayment) und versucht, sie nachträglich
    // per updateCredit zu ändern — ohne Skipper/Admin zu sein.
    mockedRequireSkipperOrAdmin.mockResolvedValue({ ok: false, message: "nein" });
    const { supabase } = makeUpdateCreditSupabase({
      existing: {
        created_by: CREDIT_FROM,
        type: "credit",
        trip_id: TRIP_ID,
        deleted_at: null,
        amount: 100,
        credit_from: CREDIT_FROM,
        credit_to: CREDIT_TO,
        tranche_id: null,
      },
    });
    mockedAdminClient.mockReturnValue(supabase as never);

    const res = await updateCredit({ status: "idle" }, creditFormData());

    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.message).toContain("Nur Skipper oder Admin");
    }
    // requireSkipperOrAdmin ist der EINZIGE Guard — kein Ersteller-Vorrang mehr.
    expect(mockedRequireSkipperOrAdmin).toHaveBeenCalledWith(TRIP_ID);
  });

  it("lässt tranche_id unverändert, wenn tranche_field_present fehlt (Feld nicht gerendert)", async () => {
    // Existing ist bereits einer Tranche zugeordnet. Ohne den Marker darf
    // ein (ggf. leeres) tranche_id-Feld im Formular die Zuordnung NICHT
    // stillschweigend lösen — sonst rutscht die Anzahlung ungewollt aus dem
    // Pool in die Bordkasse (das Kern-Szenario aus Fund 3d).
    mockedRequireSkipperOrAdmin.mockResolvedValue({ ok: true, personId: CREDIT_FROM });
    const { supabase, getCapturedUpdate } = makeUpdateCreditSupabase({
      existing: {
        created_by: CREDIT_FROM,
        type: "credit",
        trip_id: TRIP_ID,
        deleted_at: null,
        amount: 150,
        credit_from: CREDIT_FROM,
        credit_to: CREDIT_TO,
        tranche_id: OTHER_TRANCHE_ID,
      },
    });
    mockedAdminClient.mockReturnValue(supabase as never);

    const res = await updateCredit({ status: "idle" }, creditFormData());

    // redirect() ist im Test ein No-Op-Mock (wirft nicht wie in echtem
    // Next.js) — die Funktion läuft danach ohne Return durch, res ist also
    // undefined. Entscheidend ist: KEIN Fehler, und das Update-Payload zeigt
    // die unveränderte (nicht genullte) Tranche.
    expect((res as { status?: string } | undefined)?.status).not.toBe("error");
    expect(mockedAdvancer).not.toHaveBeenCalled();
    expect(getCapturedUpdate()?.tranche_id).toBe(OTHER_TRANCHE_ID);
  });

  it("lehnt eine Tranchen-Änderung ab, wenn der Editor die Tranchen-Rolle nicht hat", async () => {
    mockedRequireSkipperOrAdmin.mockResolvedValue({ ok: true, personId: CREDIT_FROM });
    mockedAdvancer.mockResolvedValue({ ok: false, message: "nein" });
    const { supabase } = makeUpdateCreditSupabase({
      existing: {
        created_by: CREDIT_FROM,
        type: "credit",
        trip_id: TRIP_ID,
        deleted_at: null,
        amount: 150,
        credit_from: CREDIT_FROM,
        credit_to: CREDIT_TO,
        tranche_id: null,
      },
    });
    mockedAdminClient.mockReturnValue(supabase as never);

    const res = await updateCredit(
      { status: "idle" },
      creditFormData({ tranche_field_present: "1", tranche_id: OTHER_TRANCHE_ID }),
    );

    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.message).toContain("Anzahlungstranche");
    }
    expect(mockedAdvancer).toHaveBeenCalledWith(TRIP_ID);
  });

  it("setzt confirmed_at zurück, wenn eine tranche-getaggte Gutschrift materiell geändert wird", async () => {
    mockedRequireSkipperOrAdmin.mockResolvedValue({ ok: true, personId: CREDIT_FROM });
    const { supabase, getCapturedUpdate } = makeUpdateCreditSupabase({
      existing: {
        created_by: CREDIT_FROM,
        type: "credit",
        trip_id: TRIP_ID,
        deleted_at: null,
        amount: 100, // Formular schickt 150 → Betrag ändert sich materiell
        credit_from: CREDIT_FROM,
        credit_to: CREDIT_TO,
        tranche_id: OTHER_TRANCHE_ID,
      },
    });
    mockedAdminClient.mockReturnValue(supabase as never);

    const res = await updateCredit({ status: "idle" }, creditFormData({ amount: "150,00" }));

    expect((res as { status?: string } | undefined)?.status).not.toBe("error");
    expect(getCapturedUpdate()?.confirmed_at).toBeNull();
  });

  it("lässt confirmed_at unangetastet, wenn sich an einer tranche-getaggten Gutschrift nichts ändert", async () => {
    mockedRequireSkipperOrAdmin.mockResolvedValue({ ok: true, personId: CREDIT_FROM });
    const { supabase, getCapturedUpdate } = makeUpdateCreditSupabase({
      existing: {
        created_by: CREDIT_FROM,
        type: "credit",
        trip_id: TRIP_ID,
        deleted_at: null,
        amount: 150, // identisch zum Formular → keine Bilanz-Änderung
        credit_from: CREDIT_FROM,
        credit_to: CREDIT_TO,
        tranche_id: OTHER_TRANCHE_ID,
      },
    });
    mockedAdminClient.mockReturnValue(supabase as never);

    const res = await updateCredit({ status: "idle" }, creditFormData({ description: "Umbenannt" }));

    expect((res as { status?: string } | undefined)?.status).not.toBe("error");
    expect(getCapturedUpdate()).not.toHaveProperty("confirmed_at");
  });
});

describe("deleteTransaction — nur Ersteller/Skipper/Admin (Fund S-2)", () => {
  const OTHER_CREATOR = "aaaaaaaa-0000-4000-8000-00000000000c";
  function makeDeleteSupabase(existing: Record<string, unknown> | null) {
    const make = () => {
      const b: Record<string, unknown> = {};
      const self = () => b;
      b.select = self;
      b.eq = self;
      b.update = self;
      b.maybeSingle = () => Promise.resolve({ data: existing });
      return b;
    };
    return { from: () => make() };
  }

  beforeEach(() => {
    mockedRequireMember.mockReset();
    mockedRequireSkipperOrAdmin.mockReset();
    mockedIsAdmin.mockReset();
    mockedAdminClient.mockReset();
    mockedRequireMember.mockResolvedValue({ ok: true, personId: PERSON_ID });
    mockedAdminClient.mockReturnValue(
      makeDeleteSupabase({ category_id: null, trip_id: TRIP_ID, created_by: OTHER_CREATOR }) as never,
    );
  });

  it("verweigert das Löschen für ein einfaches Mitglied, das weder Ersteller noch Skipper/Admin ist", async () => {
    mockedRequireSkipperOrAdmin.mockResolvedValue({ ok: false, message: "nein" });
    mockedIsAdmin.mockResolvedValue(false);
    const res = await deleteTransaction("aaaaaaaa-0000-4000-8000-00000000000d", TRIP_ID);
    // Vor dem Fix reichte bloße Mitgliedschaft → Löschen fremder Buchungen möglich.
    expect(res.ok).toBe(false);
  });
});
