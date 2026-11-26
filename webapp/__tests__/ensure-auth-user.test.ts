// Sicherheitsrunde 2026-11, Slice 1: Verzweigungen von ensureAuthUser im
// Fall `email_exists` (Grill-Funde B1/H2/M3).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { ensureAuthUser } from "@/lib/auth/ensure-auth-user";
import { createAdminClient } from "@/lib/supabase/admin";

const mockedAdmin = vi.mocked(createAdminClient);

const EMAIL = "crew@example.test";
const EXISTS = { data: { user: null }, error: { code: "email_exists", message: "x" } };
const OK = { data: { user: { id: "u" } }, error: null };

const createUser = vi.fn();
const listUsers = vi.fn();
const updateUserById = vi.fn();
const deleteUser = vi.fn();
let personsResp: { data: unknown; error: unknown };
let privResp: { data: unknown; error: unknown };
const eqCalls: { table: string; col: string; val: unknown }[] = [];

beforeEach(() => {
  createUser.mockReset().mockResolvedValueOnce(EXISTS).mockResolvedValue(OK);
  listUsers.mockReset().mockResolvedValue({ data: { users: [] }, error: null });
  updateUserById.mockReset().mockResolvedValue(OK);
  deleteUser.mockReset().mockResolvedValue({ data: {}, error: null });
  personsResp = { data: null, error: null };
  privResp = { data: null, error: null };
  eqCalls.length = 0;
  mockedAdmin.mockReturnValue({
    auth: { admin: { createUser, listUsers, updateUserById, deleteUser } },
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (col: string, val: unknown) => {
        eqCalls.push({ table, col, val });
        return b;
      };
      b.maybeSingle = async () => (table === "persons" ? personsResp : privResp);
      return b;
    },
  } as never);
});

function existing(meta: Record<string, unknown>, confirmed: string | null = "2026-01-01T00:00:00Z") {
  return { id: "u-alt", email: EMAIL, app_metadata: meta, email_confirmed_at: confirmed };
}

describe("ensureAuthUser — Bestandskonto (email_exists)", () => {
  it("B1: Konto ohne Anker und ohne Verknüpfung wird NICHT geankert, sondern gelöscht und neu angelegt", async () => {
    listUsers.mockResolvedValue({ data: { users: [existing({ provider: "email" })] }, error: null });

    const res = await ensureAuthUser(EMAIL);

    expect(res).toEqual({ ok: true });
    expect(updateUserById).not.toHaveBeenCalled();
    expect(deleteUser).toHaveBeenCalledWith("u-alt");
    expect(createUser).toHaveBeenCalledTimes(2);
    expect(createUser).toHaveBeenLastCalledWith({
      email: EMAIL,
      email_confirm: true,
      app_metadata: { bordkasse_email: EMAIL },
    });
    // Verknüpfung wurde per auth_user_id des Bestandskontos geprüft.
    expect(eqCalls).toContainEqual({ table: "persons", col: "auth_user_id", val: "u-alt" });
  });

  it("B1: scheitert das Löschen → fail-closed, kein Neuanlegen", async () => {
    listUsers.mockResolvedValue({ data: { users: [existing({})] }, error: null });
    deleteUser.mockResolvedValue({ data: null, error: { code: "unexpected_failure" } });

    const res = await ensureAuthUser(EMAIL);

    expect(res.ok).toBe(false);
    expect(createUser).toHaveBeenCalledTimes(1);
  });

  it("verknüpftes Altkonto ohne Anker, Personen-Adresse passt → bestätigen + ankern", async () => {
    listUsers.mockResolvedValue({ data: { users: [existing({}, null)] }, error: null });
    personsResp = { data: { id: "p-1" }, error: null };
    privResp = { data: { email: "Crew@Example.test" }, error: null };

    const res = await ensureAuthUser(EMAIL);

    expect(res).toEqual({ ok: true });
    expect(updateUserById).toHaveBeenCalledWith("u-alt", {
      email_confirm: true,
      app_metadata: { bordkasse_email: EMAIL },
    });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("Grill 2/1: verknüpftes Altkonto ohne Anker hat die Adresse besetzt → zurück auf Personen-Adresse (mit Anker), dann neu", async () => {
    listUsers.mockResolvedValue({ data: { users: [existing({})] }, error: null });
    personsResp = { data: { id: "p-1" }, error: null };
    privResp = { data: { email: "Eigen@Example.test" }, error: null };

    const res = await ensureAuthUser(EMAIL);

    expect(res).toEqual({ ok: true });
    expect(updateUserById).toHaveBeenCalledWith("u-alt", {
      email: "eigen@example.test",
      email_confirm: true,
      app_metadata: { bordkasse_email: "eigen@example.test" },
    });
    // Nie die angefragte Adresse als Anker für das besetzende Konto.
    expect(updateUserById).not.toHaveBeenCalledWith("u-alt", expect.objectContaining({
      app_metadata: { bordkasse_email: EMAIL },
    }));
    expect(deleteUser).not.toHaveBeenCalled();
    expect(createUser).toHaveBeenCalledTimes(2);
  });

  it("PR #299/1: verknüpftes Konto OHNE hinterlegte Personen-Adresse → fail-closed, weder parken noch löschen", async () => {
    listUsers.mockResolvedValue({ data: { users: [existing({})] }, error: null });
    personsResp = { data: { id: "p-1" }, error: null };
    privResp = { data: null, error: null };

    const res = await ensureAuthUser(EMAIL);

    expect(res).toEqual({ ok: false, code: "linked_without_address" });
    expect(updateUserById).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
    expect(createUser).toHaveBeenCalledTimes(1);
  });

  it("Lesefehler bei der Verknüpfungsprüfung → fail-closed", async () => {
    listUsers.mockResolvedValue({ data: { users: [existing({})] }, error: null });
    personsResp = { data: null, error: { code: "XX000" } };

    const res = await ensureAuthUser(EMAIL);

    expect(res.ok).toBe(false);
    expect(updateUserById).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("M3: Anker passt und Konto bestätigt → kein Schreibzugriff", async () => {
    listUsers.mockResolvedValue({ data: { users: [existing({ bordkasse_email: EMAIL })] }, error: null });

    const res = await ensureAuthUser(EMAIL);

    expect(res).toEqual({ ok: true });
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("Anker passt, Konto unbestätigt → nur bestätigen", async () => {
    listUsers.mockResolvedValue({ data: { users: [existing({ bordkasse_email: EMAIL }, null)] }, error: null });

    const res = await ensureAuthUser(EMAIL);

    expect(res).toEqual({ ok: true });
    expect(updateUserById).toHaveBeenCalledWith("u-alt", { email_confirm: true });
  });

  it("H2: Konto mit fremdem Anker belegt die Adresse → Adresse auf den Anker zurück, dann neu anlegen", async () => {
    listUsers.mockResolvedValue({
      data: { users: [existing({ bordkasse_email: "besetzer@example.test" })] },
      error: null,
    });

    const res = await ensureAuthUser(EMAIL);

    expect(res).toEqual({ ok: true });
    expect(updateUserById).toHaveBeenCalledWith("u-alt", {
      email: "besetzer@example.test",
      email_confirm: true,
      app_metadata: { bordkasse_email: "besetzer@example.test" },
    });
    // Der Besetzer bekommt KEINEN Anker für die fremde Adresse.
    expect(updateUserById).not.toHaveBeenCalledWith("u-alt", expect.objectContaining({
      app_metadata: { bordkasse_email: EMAIL },
    }));
    expect(createUser).toHaveBeenCalledTimes(2);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("Grill 2/2: Anker-Adresse inzwischen vergeben → Konto wird geparkt, dann neu", async () => {
    listUsers.mockResolvedValue({
      data: { users: [existing({ bordkasse_email: "besetzer@example.test" })] },
      error: null,
    });
    updateUserById
      .mockResolvedValueOnce({ data: null, error: { code: "23505" } })
      .mockResolvedValue(OK);

    const res = await ensureAuthUser(EMAIL);

    expect(res).toEqual({ ok: true });
    expect(updateUserById).toHaveBeenLastCalledWith("u-alt", {
      email: "displaced+u-alt@bordkasse.invalid",
      email_confirm: true,
    });
    expect(createUser).toHaveBeenCalledTimes(2);
  });

  it("scheitert auch das Parken → fail-closed, kein Neuanlegen", async () => {
    listUsers.mockResolvedValue({
      data: { users: [existing({ bordkasse_email: "besetzer@example.test" })] },
      error: null,
    });
    updateUserById.mockResolvedValue({ data: null, error: { code: "unexpected_failure" } });

    const res = await ensureAuthUser(EMAIL);

    expect(res.ok).toBe(false);
    expect(createUser).toHaveBeenCalledTimes(1);
  });

  it("findet das Konto auch auf Seite 2 von listUsers", async () => {
    const filler = Array.from({ length: 1000 }, (_, i) => ({ id: `f${i}`, email: `f${i}@example.test`, app_metadata: {} }));
    listUsers
      .mockResolvedValueOnce({ data: { users: filler }, error: null })
      .mockResolvedValueOnce({ data: { users: [existing({ bordkasse_email: EMAIL })] }, error: null });

    const res = await ensureAuthUser(EMAIL);

    expect(res).toEqual({ ok: true });
    expect(listUsers).toHaveBeenCalledTimes(2);
    expect(listUsers).toHaveBeenLastCalledWith({ page: 2, perPage: 1000 });
  });

  it("Konto trotz email_exists nicht auffindbar → fail-closed", async () => {
    const res = await ensureAuthUser(EMAIL);

    expect(res).toEqual({ ok: false, code: "user_not_found" });
    expect(listUsers).toHaveBeenCalledTimes(1);
  });

  it("listUsers-Fehler → fail-closed", async () => {
    // Auch wenn die Antwort trotz Fehler einen passenden Treffer trüge: fail-closed.
    listUsers.mockResolvedValue({
      data: { users: [existing({ bordkasse_email: EMAIL })] },
      error: { code: "unexpected_failure" },
    });

    const res = await ensureAuthUser(EMAIL);

    expect(res.ok).toBe(false);
  });
});

describe("ensureAuthUser — freie Adresse, aber App-Konto mit diesem Anker hat sie weggeändert (PR #299/2)", () => {
  beforeEach(() => {
    createUser.mockReset().mockResolvedValue({ data: { user: { id: "u-zwilling" } }, error: null });
  });

  it("löscht den frischen Zwilling und setzt das Anker-Konto auf die Adresse zurück", async () => {
    listUsers.mockResolvedValue({
      data: {
        users: [
          { id: "u-zwilling", email: EMAIL, app_metadata: { bordkasse_email: EMAIL } },
          { id: "u-alt", email: "woanders@example.test", app_metadata: { bordkasse_email: EMAIL } },
        ],
      },
      error: null,
    });

    const res = await ensureAuthUser(EMAIL);

    expect(res).toEqual({ ok: true });
    expect(deleteUser).toHaveBeenCalledWith("u-zwilling");
    expect(updateUserById).toHaveBeenCalledWith("u-alt", { email: EMAIL, email_confirm: true });
  });

  it("kein anderes Konto mit diesem Anker → nichts weiter (normales Neukonto)", async () => {
    listUsers.mockResolvedValue({
      data: { users: [{ id: "u-zwilling", email: EMAIL, app_metadata: { bordkasse_email: EMAIL } }] },
      error: null,
    });

    const res = await ensureAuthUser(EMAIL);

    expect(res).toEqual({ ok: true });
    expect(deleteUser).not.toHaveBeenCalled();
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("Suche scheitert → Neukonto bleibt (fail-open nur für diese Reparatur)", async () => {
    listUsers.mockResolvedValue({ data: { users: [] }, error: { code: "unexpected_failure" } });

    const res = await ensureAuthUser(EMAIL);

    expect(res).toEqual({ ok: true });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("Zurücksetzen scheitert → fail-closed (keine Mail an ein personenloses Konto)", async () => {
    listUsers.mockResolvedValue({
      data: { users: [{ id: "u-alt", email: "woanders@example.test", app_metadata: { bordkasse_email: EMAIL } }] },
      error: null,
    });
    updateUserById.mockResolvedValue({ data: null, error: { code: "23505" } });

    const res = await ensureAuthUser(EMAIL);

    expect(res.ok).toBe(false);
  });

  it("scheitert das Löschen des Zwillings → fail-closed, Anker-Konto unangetastet", async () => {
    listUsers.mockResolvedValue({
      data: { users: [{ id: "u-alt", email: "woanders@example.test", app_metadata: { bordkasse_email: EMAIL } }] },
      error: null,
    });
    deleteUser.mockResolvedValue({ data: null, error: { code: "unexpected_failure" } });

    const res = await ensureAuthUser(EMAIL);

    expect(res).toEqual({ ok: false, code: "unexpected_failure" });
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("löscht den Zwilling VOR dem Zurücksetzen (Adresse ist UNIQUE)", async () => {
    // Zustandsbehafteter Mock: solange der Zwilling lebt, ist die Adresse belegt.
    let twinAlive = true;
    deleteUser.mockImplementation(async (id: string) => {
      if (id === "u-zwilling") twinAlive = false;
      return { data: {}, error: null };
    });
    updateUserById.mockImplementation(async (_id: string, attrs: { email?: string }) =>
      attrs.email === EMAIL && twinAlive
        ? { data: null, error: { code: "23505" } }
        : { data: { user: { id: _id } }, error: null },
    );
    listUsers.mockResolvedValue({
      data: { users: [{ id: "u-alt", email: "woanders@example.test", app_metadata: { bordkasse_email: EMAIL } }] },
      error: null,
    });

    const res = await ensureAuthUser(EMAIL);

    expect(res).toEqual({ ok: true });
    expect(twinAlive).toBe(false);
    expect(updateUserById).toHaveBeenCalledWith("u-alt", { email: EMAIL, email_confirm: true });
  });

  it("findet das Anker-Konto auch auf Seite 2", async () => {
    const filler = Array.from({ length: 1000 }, (_, i) => ({ id: `f${i}`, email: `f${i}@example.test`, app_metadata: {} }));
    listUsers
      .mockResolvedValueOnce({ data: { users: filler }, error: null })
      .mockResolvedValueOnce({
        data: { users: [{ id: "u-alt", email: "woanders@example.test", app_metadata: { bordkasse_email: EMAIL } }] },
        error: null,
      });

    const res = await ensureAuthUser(EMAIL);

    expect(res).toEqual({ ok: true });
    expect(listUsers).toHaveBeenCalledTimes(2);
    expect(deleteUser).toHaveBeenCalledWith("u-zwilling");
    expect(updateUserById).toHaveBeenCalledWith("u-alt", { email: EMAIL, email_confirm: true });
  });

  it("listUsers wirft → fail-open wie bei { error }", async () => {
    listUsers.mockRejectedValue(new Error("netz weg"));

    const res = await ensureAuthUser(EMAIL);

    expect(res).toEqual({ ok: true });
    expect(deleteUser).not.toHaveBeenCalled();
  });
});

describe("ensureAuthUser — Anker-Zwilling auch nach Löschen + Neuanlegen", () => {
  it("unverknüpftes Konto gelöscht, neu angelegt, anderes Konto trägt den Anker → Zwilling weg, Anker-Konto zurück", async () => {
    createUser.mockReset()
      .mockResolvedValueOnce(EXISTS)
      .mockResolvedValue({ data: { user: { id: "u-zwilling" } }, error: null });
    listUsers
      // 1. Suche nach dem Bestandskonto mit der Adresse (ohne Anker, unverknüpft)
      .mockResolvedValueOnce({ data: { users: [existing({})] }, error: null })
      // 2. Anker-Suche nach der Neuanlage
      .mockResolvedValueOnce({
        data: { users: [{ id: "u-anker", email: "woanders@example.test", app_metadata: { bordkasse_email: EMAIL } }] },
        error: null,
      });

    const res = await ensureAuthUser(EMAIL);

    expect(res).toEqual({ ok: true });
    expect(deleteUser).toHaveBeenNthCalledWith(1, "u-alt");
    expect(deleteUser).toHaveBeenNthCalledWith(2, "u-zwilling");
    expect(updateUserById).toHaveBeenCalledWith("u-anker", { email: EMAIL, email_confirm: true });
  });

  it("nach Verdrängen eines besetzenden Kontos ebenfalls Anker-Suche", async () => {
    createUser.mockReset()
      .mockResolvedValueOnce(EXISTS)
      .mockResolvedValue({ data: { user: { id: "u-zwilling" } }, error: null });
    listUsers
      .mockResolvedValueOnce({
        data: { users: [existing({ bordkasse_email: "besetzer@example.test" })] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { users: [{ id: "u-anker", email: "woanders@example.test", app_metadata: { bordkasse_email: EMAIL } }] },
        error: null,
      });

    const res = await ensureAuthUser(EMAIL);

    expect(res).toEqual({ ok: true });
    expect(deleteUser).toHaveBeenCalledWith("u-zwilling");
    expect(updateUserById).toHaveBeenCalledWith("u-anker", { email: EMAIL, email_confirm: true });
  });

  it("nach Verdrängen eines verknüpften Altkontos ebenfalls Anker-Suche", async () => {
    createUser.mockReset()
      .mockResolvedValueOnce(EXISTS)
      .mockResolvedValue({ data: { user: { id: "u-zwilling" } }, error: null });
    personsResp = { data: { id: "p-1" }, error: null };
    privResp = { data: { email: "eigen@example.test" }, error: null };
    listUsers
      .mockResolvedValueOnce({ data: { users: [existing({})] }, error: null })
      .mockResolvedValueOnce({
        data: { users: [{ id: "u-anker", email: "woanders@example.test", app_metadata: { bordkasse_email: EMAIL } }] },
        error: null,
      });

    const res = await ensureAuthUser(EMAIL);

    expect(res).toEqual({ ok: true });
    expect(deleteUser).toHaveBeenCalledWith("u-zwilling");
    expect(updateUserById).toHaveBeenCalledWith("u-anker", { email: EMAIL, email_confirm: true });
  });
});
