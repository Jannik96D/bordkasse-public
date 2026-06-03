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
  isAdmin: vi.fn(),
}));
vi.mock("@/lib/auth/get-current-person", () => ({ getCurrentPerson: vi.fn() }));

import { createExpense, createCredit } from "@/lib/actions/transactions";
import { getCurrentPerson } from "@/lib/auth/get-current-person";

const mockedPerson = vi.mocked(getCurrentPerson);

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
