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

import { deleteMyAccount } from "@/app/profile/actions";
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
