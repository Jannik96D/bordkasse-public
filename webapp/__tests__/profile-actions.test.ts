// Regression zu Migration 0051 (Sanierungsplan 2026-09, PR 2, Fund 2):
// deleteMyAccount() muss admin_delete_person_data MIT der eigenen person.id
// aufrufen, nicht das alte, in Produktion nie funktionierende delete_my_account
// (das die Person über auth.uid() erraten wollte — bei einem Service-Role-
// RPC-Aufruf immer NULL, siehe Migrations-Kommentar).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// Anders als im etablierten Mock-Muster (z. B. transaction-actions.test.ts)
// wirft dieser Mock wie das echte next/navigation:redirect() — sonst würde
// ein fehlendes `return` nach einem redirect() im Erfolgspfad unbemerkt den
// nachfolgenden Code (hier: einen zweiten, falschen Redirect) mitausführen,
// was in Produktion durch den echten Wurf verhindert wird.
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/get-current-person", () => ({ getCurrentPerson: vi.fn() }));

import { deleteMyAccount, exportMyData } from "@/app/profile/actions";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

const mockedPerson = vi.mocked(getCurrentPerson);
const mockedAdminClient = vi.mocked(createAdminClient);
const mockedCookieClient = vi.mocked(createClient);
const mockedRedirect = vi.mocked(redirect);

const PERSON_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const AUTH_USER_ID = "aaaaaaaa-0000-4000-8000-000000000002";

function makeAdmin(rpcResult: { data?: string | null; error?: { message: string } | null }) {
  return {
    rpc: vi.fn().mockResolvedValue(rpcResult),
    auth: { admin: { deleteUser: vi.fn().mockResolvedValue({ error: null }) } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedCookieClient.mockResolvedValue({
    auth: { signOut: vi.fn().mockResolvedValue({}) },
  } as never);
});

describe("deleteMyAccount", () => {
  it("ruft admin_delete_person_data mit der eigenen person.id auf, nicht das alte delete_my_account", async () => {
    mockedPerson.mockResolvedValue({ id: PERSON_ID, auth_user_id: AUTH_USER_ID } as never);
    const admin = makeAdmin({ data: "ok", error: null });
    mockedAdminClient.mockReturnValue(admin as never);

    await expect(deleteMyAccount({ status: "idle" }, new FormData())).rejects.toThrow(
      "NEXT_REDIRECT",
    );

    expect(admin.rpc).toHaveBeenCalledWith("admin_delete_person_data", { p_person_id: PERSON_ID });
    expect(admin.rpc).not.toHaveBeenCalledWith("delete_my_account");
    expect(mockedRedirect).toHaveBeenCalledTimes(1);
    expect(mockedRedirect).toHaveBeenCalledWith("/?account_deleted=1");
  });

  it("weist ohne Login ab, ohne die RPC aufzurufen", async () => {
    mockedPerson.mockResolvedValue(null);
    const admin = makeAdmin({ data: "ok", error: null });
    mockedAdminClient.mockReturnValue(admin as never);

    const result = await deleteMyAccount({ status: "idle" }, new FormData());

    expect(admin.rpc).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "error", message: "Nicht angemeldet." });
  });

  it("meldet has_active_bookings als eigene Fehlermeldung, statt umzuleiten", async () => {
    mockedPerson.mockResolvedValue({ id: PERSON_ID, auth_user_id: AUTH_USER_ID } as never);
    const admin = makeAdmin({ data: "has_active_bookings", error: null });
    mockedAdminClient.mockReturnValue(admin as never);

    const result = await deleteMyAccount({ status: "idle" }, new FormData());

    expect(result.status).toBe("error");
    expect(mockedRedirect).not.toHaveBeenCalled();
  });

  it("meldet is_active_item_payee (Posten-Empfänger in laufendem Törn, Migration 0058) als eigene Fehlermeldung", async () => {
    mockedPerson.mockResolvedValue({ id: PERSON_ID, auth_user_id: AUTH_USER_ID } as never);
    const admin = makeAdmin({ data: "is_active_item_payee", error: null });
    mockedAdminClient.mockReturnValue(admin as never);

    const result = await deleteMyAccount({ status: "idle" }, new FormData());

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.message).toMatch(/weitere Zahlung/);
    expect(result.message).not.toMatch(/Unerwartete Antwort/);
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
    expect(mockedRedirect).not.toHaveBeenCalled();
  });

  it("leitet mit login_cleanup_pending=1 um, wenn das Auth-Konto nicht gelöscht werden konnte", async () => {
    mockedPerson.mockResolvedValue({ id: PERSON_ID, auth_user_id: AUTH_USER_ID } as never);
    const admin = makeAdmin({ data: "ok", error: null });
    admin.auth.admin.deleteUser = vi.fn().mockResolvedValue({ error: { message: "boom" } });
    mockedAdminClient.mockReturnValue(admin as never);

    await expect(deleteMyAccount({ status: "idle" }, new FormData())).rejects.toThrow(
      "NEXT_REDIRECT",
    );

    // Genau EIN Redirect (der `login_cleanup_pending`-Pfad) — der Mock wirft
    // wie das echte redirect(), ein fehlendes `return` würde also hier (wie
    // in Produktion) den nachfolgenden Erfolgs-Redirect gar nicht erst
    // erreichen lassen, statt es nur bei `toHaveBeenCalledWith` zu verstecken.
    expect(mockedRedirect).toHaveBeenCalledTimes(1);
    expect(mockedRedirect).toHaveBeenCalledWith("/?account_deleted=1&login_cleanup_pending=1");
  });
});

// ── exportMyData (DSGVO Art. 20) ─────────────────────────────────────────
// Kettenfähiger Supabase-Mock: jede Abfrage `from(table).select().eq()…`
// löst zu `results[table]` auf; die gesetzten Filter werden protokolliert,
// damit der Test prüfen kann, WORAUF eine Tabelle eingeschränkt wurde.
type QueryResult = { data: unknown; error: { message: string } | null };

function makeExportAdmin(overrides: Record<string, QueryResult> = {}) {
  const calls: { table: string; filters: [string, unknown][] }[] = [];
  const defaults: Record<string, QueryResult> = {
    persons: { data: { id: PERSON_ID, display_name: "Anna" }, error: null },
    persons_private: { data: null, error: null },
    trip_members: { data: [], error: null },
    transaction_participants: { data: [], error: null },
    prepayment_obligations: { data: [], error: null },
    prepayment_item_obligations: { data: [], error: null },
    prepayment_items: { data: [], error: null },
    transactions: { data: [], error: null },
  };
  const from = vi.fn((table: string) => {
    const call = { table, filters: [] as [string, unknown][] };
    calls.push(call);
    const result = overrides[table] ?? defaults[table] ?? { data: null, error: null };
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        call.filters.push([col, val]);
        return builder;
      },
      is: (col: string, val: unknown) => {
        call.filters.push([col, val]);
        return builder;
      },
      maybeSingle: () => Promise.resolve(result),
      then: (resolve: (r: QueryResult) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  });
  return { admin: { from }, calls };
}

describe("exportMyData", () => {
  it("exportiert Posten, bei denen die Person Empfänger ist (payee_person_id)", async () => {
    mockedPerson.mockResolvedValue({ id: PERSON_ID, auth_user_id: AUTH_USER_ID } as never);
    const item = { id: "i1", trip_id: "t1", label: "Flüge", total_amount: 300, due_date: null };
    const { admin, calls } = makeExportAdmin({
      prepayment_items: { data: [item], error: null },
    });
    mockedAdminClient.mockReturnValue(admin as never);

    const result = await exportMyData();

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(JSON.parse(result.json).posten_als_empfaenger).toEqual([item]);
    // Streng auf die eigene Person begrenzt — kein ungefilterter Posten-Dump.
    const itemCalls = calls.filter((c) => c.table === "prepayment_items");
    expect(itemCalls).toHaveLength(1);
    expect(itemCalls[0].filters).toEqual([["payee_person_id", PERSON_ID]]);
  });

  it("bricht ab, wenn die Posten-Empfänger-Abfrage scheitert (kein stiller Teil-Export)", async () => {
    mockedPerson.mockResolvedValue({ id: PERSON_ID, auth_user_id: AUTH_USER_ID } as never);
    const { admin } = makeExportAdmin({
      prepayment_items: { data: null, error: { message: "relation does not exist" } },
    });
    mockedAdminClient.mockReturnValue(admin as never);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await exportMyData();

    expect(result).toEqual({
      status: "error",
      message: "Export fehlgeschlagen. Bitte später erneut versuchen.",
    });
    consoleSpy.mockRestore();
  });

  it("bricht ab, wenn eine Buchungs-Abfrage scheitert (z. B. fehlende item_id-Spalte)", async () => {
    mockedPerson.mockResolvedValue({ id: PERSON_ID, auth_user_id: AUTH_USER_ID } as never);
    const { admin } = makeExportAdmin({
      transactions: { data: null, error: { message: "column transactions.item_id does not exist" } },
    });
    mockedAdminClient.mockReturnValue(admin as never);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await exportMyData();

    expect(result.status).toBe("error");
    consoleSpy.mockRestore();
  });
});
