// Sicherheitsrunde 2026-11, Slice 6: purgeTripNow(force=true) ist
// unwiderruflich — nur Eigentümer/Admin, und nur bei ausgeglichenem
// Anzahlungs-Pool und ausgeglichenen weiteren Zahlungen.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/authz", () => ({
  requireSkipperOrAdmin: vi.fn(),
  requireTripOwnerOrAdmin: vi.fn(),
  requireAdmin: vi.fn(),
  requireAdminOrTripCreator: vi.fn(),
  isAdmin: vi.fn(),
}));
vi.mock("@/lib/queries/prepayments", () => ({ getPrepaymentPoolBalances: vi.fn() }));
vi.mock("@/lib/queries/prepayment-items", () => ({ getItemPotBalances: vi.fn() }));
vi.mock("@/lib/db/audit", () => ({ logAudit: vi.fn() }));

import { purgeTripNow } from "@/lib/actions/trips";
import { requireSkipperOrAdmin, requireTripOwnerOrAdmin } from "@/lib/auth/authz";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrepaymentPoolBalances } from "@/lib/queries/prepayments";
import { getItemPotBalances } from "@/lib/queries/prepayment-items";

const TRIP = "aaaaaaaa-0000-4000-8000-000000000001";
const P1 = "aaaaaaaa-0000-4000-8000-000000000002";
const rpc = vi.fn();

beforeEach(() => {
  vi.mocked(requireSkipperOrAdmin).mockReset().mockResolvedValue({ ok: true, personId: P1 });
  vi.mocked(requireTripOwnerOrAdmin).mockReset().mockResolvedValue({ ok: true, personId: P1 });
  rpc.mockReset().mockResolvedValue({ data: "ok", error: null });
  vi.mocked(createAdminClient).mockReturnValue({ rpc } as never);
  vi.mocked(getPrepaymentPoolBalances)
    .mockReset()
    .mockResolvedValue([{ person_id: P1, soll: 100, paid: 100, balance: 0 }]);
  vi.mocked(getItemPotBalances).mockReset().mockResolvedValue(new Map([[P1, 0]]));
});

describe("purgeTripNow force", () => {
  it("Co-Skipper + force → abgelehnt, RPC nicht aufgerufen", async () => {
    vi.mocked(requireTripOwnerOrAdmin).mockResolvedValue({ ok: false, message: "nein" });
    const r = await purgeTripNow(TRIP, true);
    expect(r.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("Eigentümer + offener Pool → abgelehnt", async () => {
    vi.mocked(getPrepaymentPoolBalances).mockResolvedValue([{ person_id: P1, soll: 100, paid: 40, balance: -60 }]);
    const r = await purgeTripNow(TRIP, true);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Anzahlung");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("Eigentümer + offener Posten → abgelehnt", async () => {
    vi.mocked(getItemPotBalances).mockResolvedValue(new Map([[P1, 12.5]]));
    const r = await purgeTripNow(TRIP, true);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("weiteren Zahlungen");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("Eigentümer, alles ausgeglichen → erlaubt", async () => {
    const r = await purgeTripNow(TRIP, true);
    expect(r.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith("purge_trip_data", { p_trip_id: TRIP, p_force: true });
  });

  it("Lesefehler Pool → abgelehnt (fail-closed)", async () => {
    vi.mocked(getPrepaymentPoolBalances).mockRejectedValue(new Error("db down"));
    const r = await purgeTripNow(TRIP, true);
    expect(r.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("Lesefehler Posten → abgelehnt (fail-closed)", async () => {
    vi.mocked(getItemPotBalances).mockRejectedValue(new Error("db down"));
    const r = await purgeTripNow(TRIP, true);
    expect(r.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("ohne force: Co-Skipper darf wie bisher, keine Saldenprüfung", async () => {
    vi.mocked(getPrepaymentPoolBalances).mockResolvedValue([{ person_id: P1, soll: 100, paid: 0, balance: -100 }]);
    const r = await purgeTripNow(TRIP, false);
    expect(r.ok).toBe(true);
    expect(requireTripOwnerOrAdmin).not.toHaveBeenCalled();
    expect(getPrepaymentPoolBalances).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("purge_trip_data", { p_trip_id: TRIP, p_force: false });
  });
});
