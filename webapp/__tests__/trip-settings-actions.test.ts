// Sanierungsplan PR 9a — Fund 1 + Fund 2:
//
// Fund 1: toggleArchive/updateTripType/updateTripCurrencies/
// setPrepaymentDeclined riefen `.update(...)` auf, OHNE die zurückgegebene
// `{error}` zu prüfen — ein fehlgeschlagenes UPDATE (RLS/Netzwerk/
// Constraint) blieb unbemerkt, `revalidatePath` lief trotzdem, und die
// Funktionen hatten gar keinen Rückgabewert. Jetzt geben alle vier
// `{ok:boolean; message?:string}` zurück und überspringen `revalidatePath`
// bei einem DB-Fehler.
//
// Fund 2: `deleteTrip` nutzte `requireSkipperOrAdmin` (lässt JEDEN
// Co-Skipper hart löschen) ohne jede Prüfung auf vorhandene Buchungen oder
// bereits verschickte Abrechnung. Jetzt: nur Original-Skipper/Admin
// (`requireTripOwnerOrAdmin`), Block bei offenen Buchungen ODER
// verschickter Abrechnung, Rückgabewert statt blindem redirect.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/authz", () => ({
  requireSkipperOrAdmin: vi.fn(),
  requireTripOwnerOrAdmin: vi.fn(),
  requireAdmin: vi.fn(),
  requireAdminOrTripCreator: vi.fn(),
  isAdmin: vi.fn(),
}));

import {
  toggleArchive,
  updateTripType,
  updateTripCurrencies,
  setPrepaymentDeclined,
  deleteTrip,
} from "@/lib/actions/trips";
import { requireSkipperOrAdmin, requireTripOwnerOrAdmin } from "@/lib/auth/authz";
import { createAdminClient } from "@/lib/supabase/admin";
import { revalidatePath } from "next/cache";

const mockedRequireSkipperOrAdmin = vi.mocked(requireSkipperOrAdmin);
const mockedRequireTripOwnerOrAdmin = vi.mocked(requireTripOwnerOrAdmin);
const mockedAdminClient = vi.mocked(createAdminClient);
const mockedRevalidatePath = vi.mocked(revalidatePath);

const TRIP_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER_ID = "aaaaaaaa-0000-4000-8000-000000000002";

type TableBehavior = { data?: unknown; error?: unknown; count?: number | number[] };

function makeSupabase(tables: Record<string, TableBehavior> = {}) {
  // Pro Tabelle eine Kopie der `count`-Queue, damit aufeinanderfolgende
  // Aufrufe (z.B. der TOCTOU-Re-Check in deleteTrip) unterschiedliche Werte
  // liefern können, statt immer denselben statischen Wert zu wiederholen.
  const countQueues = new Map<string, number[]>();
  for (const [table, behavior] of Object.entries(tables)) {
    if (Array.isArray(behavior.count)) countQueues.set(table, [...behavior.count]);
  }
  const make = (table: string) => {
    const behavior = tables[table] ?? {};
    const b: Record<string, unknown> = {};
    const self = () => b;
    b.select = self;
    b.eq = self;
    b.is = self;
    b.update = self;
    b.delete = self;
    b.insert = () => Promise.resolve({ error: null }); // logAudit
    b.maybeSingle = () => Promise.resolve({ data: behavior.data ?? null, error: behavior.error ?? null });
    b.then = (onFulfilled: (v: unknown) => unknown) => {
      const queue = countQueues.get(table);
      const count = queue && queue.length > 0 ? queue.shift()! : (Array.isArray(behavior.count) ? 0 : (behavior.count ?? 0));
      return Promise.resolve({ count, error: behavior.error ?? null }).then(onFulfilled);
    };
    return b;
  };
  return { from: (table: string) => make(table) };
}

beforeEach(() => {
  mockedRequireSkipperOrAdmin.mockReset();
  mockedRequireTripOwnerOrAdmin.mockReset();
  mockedAdminClient.mockReset();
  mockedRevalidatePath.mockReset();
  mockedRequireSkipperOrAdmin.mockResolvedValue({ ok: true, personId: OWNER_ID });
  mockedRequireTripOwnerOrAdmin.mockResolvedValue({ ok: true, personId: OWNER_ID });
});

describe("Fund 1 — Fehler bei trips.update() jetzt sichtbar", () => {
  it("toggleArchive gibt ok:false zurück, wenn das UPDATE scheitert", async () => {
    const supabase = makeSupabase({ trips: { error: { message: "connection reset" } } });
    mockedAdminClient.mockReturnValue(supabase as never);

    const res = await toggleArchive(TRIP_ID, true);

    expect(res.ok).toBe(false);
    // Bei einem DB-Fehler darf revalidatePath NICHT laufen — sonst zeigt die
    // Seite eine "erfolgreiche" Änderung an, die nie gespeichert wurde.
    expect(mockedRevalidatePath).not.toHaveBeenCalled();
  });

  it("toggleArchive gibt ok:true zurück, wenn das UPDATE klappt", async () => {
    const supabase = makeSupabase({ trips: { error: null } });
    mockedAdminClient.mockReturnValue(supabase as never);

    const res = await toggleArchive(TRIP_ID, true);

    expect(res.ok).toBe(true);
    expect(mockedRevalidatePath).toHaveBeenCalled();
  });

  it("updateTripType gibt ok:false zurück, wenn das UPDATE scheitert", async () => {
    const supabase = makeSupabase({ trips: { error: { message: "constraint violation" } } });
    mockedAdminClient.mockReturnValue(supabase as never);

    const res = await updateTripType(TRIP_ID, "other");

    expect(res.ok).toBe(false);
    expect(mockedRevalidatePath).not.toHaveBeenCalled();
  });

  it("updateTripCurrencies gibt ok:false zurück, wenn das UPDATE scheitert", async () => {
    const supabase = makeSupabase({ trips: { error: { message: "timeout" } } });
    mockedAdminClient.mockReturnValue(supabase as never);

    const res = await updateTripCurrencies(TRIP_ID, ["SEK"]);

    expect(res.ok).toBe(false);
    expect(mockedRevalidatePath).not.toHaveBeenCalled();
  });

  it("setPrepaymentDeclined gibt ok:false zurück, wenn das UPDATE scheitert", async () => {
    const supabase = makeSupabase({ trips: { error: { message: "network error" } } });
    mockedAdminClient.mockReturnValue(supabase as never);

    const res = await setPrepaymentDeclined(TRIP_ID, true);

    expect(res.ok).toBe(false);
    expect(mockedRevalidatePath).not.toHaveBeenCalled();
  });
});

describe("Fund 2 — deleteTrip enger geschützt + geblockt bei Buchungen/Abrechnung", () => {
  it("lehnt einen Co-Skipper ab (nur Original-Skipper/Admin dürfen löschen)", async () => {
    mockedRequireTripOwnerOrAdmin.mockResolvedValue({ ok: false, message: "Nur der ursprüngliche Skipper oder ein Admin darf das." });
    const supabase = makeSupabase();
    mockedAdminClient.mockReturnValue(supabase as never);

    const res = await deleteTrip(TRIP_ID);

    expect(res.ok).toBe(false);
    expect(res.message).toContain("ursprüngliche Skipper");
  });

  it("blockiert das Löschen, wenn die Abrechnung bereits verschickt wurde", async () => {
    const supabase = makeSupabase({
      trips: { data: { settlement_announced_at: "2026-01-01T00:00:00Z" } },
    });
    mockedAdminClient.mockReturnValue(supabase as never);

    const res = await deleteTrip(TRIP_ID);

    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Abrechnung/);
  });

  it("blockiert das Löschen, wenn noch Buchungen existieren", async () => {
    const supabase = makeSupabase({
      trips: { data: { settlement_announced_at: null } },
      transactions: { count: 3 },
    });
    mockedAdminClient.mockReturnValue(supabase as never);

    const res = await deleteTrip(TRIP_ID);

    expect(res.ok).toBe(false);
    expect(res.message).toContain("Buchungen");
  });

  it("löscht weiterhin, wenn keine Buchungen existieren und keine Abrechnung verschickt wurde", async () => {
    const supabase = makeSupabase({
      trips: { data: { settlement_announced_at: null } },
      transactions: { count: 0 },
    });
    mockedAdminClient.mockReturnValue(supabase as never);

    const res = await deleteTrip(TRIP_ID);

    expect(res.ok).toBe(true);
  });

  it("fängt eine Buchung ab, die ZWISCHEN dem ersten Check und dem DELETE entstanden ist (Race, Grill-Review-Fund)", async () => {
    // Erster Check (vor dem Guard-Abschluss) sieht 0 Buchungen, der
    // Re-Check unmittelbar vor dem DELETE sieht 1 — simuliert eine Buchung,
    // die genau in diesem Fenster von einem anderen Crewmitglied angelegt
    // wurde. Ohne den Re-Check würde transactions.trip_id ON DELETE CASCADE
    // diese Buchung beim DELETE FROM trips unbemerkt mitlöschen.
    const supabase = makeSupabase({
      trips: { data: { settlement_announced_at: null } },
      transactions: { count: [0, 1] },
    });
    mockedAdminClient.mockReturnValue(supabase as never);

    const res = await deleteTrip(TRIP_ID);

    expect(res.ok).toBe(false);
    expect(res.message).toContain("neue Buchung");
  });
});
