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

import { createExpense, createCredit } from "@/lib/actions/transactions";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import {
  requireMember,
  requireSkipperAdminOrAdvancer,
} from "@/lib/auth/authz";
import { createAdminClient } from "@/lib/supabase/admin";

const mockedPerson = vi.mocked(getCurrentPerson);
const mockedRequireMember = vi.mocked(requireMember);
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
    tripDates?: { start_date: string; end_date: string; trip_type?: string };
  } = {},
) {
  const {
    trancheBelongs = true,
    foundPersonIds = [],
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
          : { data: foundPersonIds.map((person_id) => ({ person_id })) };
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

  it("lässt „An Bord“ mit Datum im Törnzeitraum durch den Datums-Guard", async () => {
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
