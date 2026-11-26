// Sicherheitsrunde 2026-11, Slice 1: Ghost-Verknüpfung nur mit
// serverseitigem Anker, Neuanlage nur für ADMIN_EMAILS, Einladung legt das
// Konto vor dem OTP selbst an.
//
// Hintergrund: `user.email` ist über GoTrue änderbar (PUT /auth/v1/user,
// Autoconfirm) — ohne Anker hätte jedes Konto per E-Mail-Wechsel eine fremde
// Ghost-Person übernehmen können, und Schritt 3 legte für JEDES Konto eine
// Person an.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/otp-mailer", () => ({ createOtpMailerClient: vi.fn() }));

import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { sendInvitationMagicLink } from "@/lib/auth/invite";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { createOtpMailerClient } from "@/lib/supabase/otp-mailer";

const mockedAdminClient = vi.mocked(createAdminClient);
const mockedCookieClient = vi.mocked(createClient);
const mockedOtpMailer = vi.mocked(createOtpMailerClient);

const AUTH_UID = "11110000-0000-4000-8000-000000000001";
const GHOST_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const NEW_ID = "aaaaaaaa-0000-4000-8000-000000000003";
const GHOST_EMAIL = "ghost@example.de";
const ADMIN_EMAIL = "admin@example.de";

type Resp = { data: unknown; error: unknown };

/**
 * Minimaler Query-Builder-Fake: pro Tabelle eine Antwort für maybeSingle,
 * eine für single (update/insert-Select) und eine für insert ohne select.
 */
function makeDb(opts: {
  persons?: Resp; // maybeSingle auf persons (Lookup per auth_user_id / Ghost)
  personsSeq?: Resp[]; // alternative: Reihenfolge der persons.maybeSingle-Antworten
  personsPrivate?: Resp; // maybeSingle auf persons_private
  updateSingle?: Resp; // persons.update().select().single()
  insertSingle?: Resp; // persons.insert().select().single()
  privInsert?: Resp; // persons_private.insert()
}) {
  const updates: { table: string; payload: unknown }[] = [];
  const inserts: { table: string; payload: unknown }[] = [];
  const deletes: { table: string }[] = [];
  const isCalls: { table: string; mode: string; col: string; val: unknown }[] = [];
  const personsSeq = [...(opts.personsSeq ?? [])];
  const make = (table: string) => {
    let mode: "select" | "update" | "insert" | "delete" = "select";
    const b: Record<string, unknown> = {};
    const self = () => b;
    b.select = self;
    b.eq = self;
    b.is = (col: string, val: unknown) => {
      isCalls.push({ table, mode, col, val });
      return b;
    };
    b.update = (payload: unknown) => {
      mode = "update";
      updates.push({ table, payload });
      return b;
    };
    b.delete = () => {
      mode = "delete";
      deletes.push({ table });
      return b;
    };
    b.insert = (payload: unknown) => {
      mode = "insert";
      inserts.push({ table, payload });
      // persons_private.insert wird ohne select awaited → thenable.
      const resp = opts.privInsert ?? { data: null, error: null };
      return Object.assign(b, {
        then: table === "persons_private"
          ? (res: (v: Resp) => unknown) => Promise.resolve(resp).then(res)
          : undefined,
      });
    };
    b.single = () => {
      if (mode === "update") return Promise.resolve(opts.updateSingle ?? { data: null, error: null });
      if (mode === "insert") return Promise.resolve(opts.insertSingle ?? { data: null, error: null });
      return Promise.resolve({ data: null, error: null });
    };
    b.maybeSingle = () => {
      if (table === "persons") {
        if (personsSeq.length) return Promise.resolve(personsSeq.shift());
        return Promise.resolve(opts.persons ?? { data: null, error: null });
      }
      if (table === "persons_private") return Promise.resolve(opts.personsPrivate ?? { data: null, error: null });
      return Promise.resolve({ data: null, error: null });
    };
    // delete().eq() wird awaited → thenable, sobald mode=delete.
    Object.defineProperty(b, "then", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const origEq = b.eq as () => unknown;
    b.eq = (...args: unknown[]) => {
      void args;
      if (mode === "delete") {
        return { then: (res: (v: Resp) => unknown) => Promise.resolve({ data: null, error: null }).then(res) };
      }
      return origEq();
    };
    return b;
  };
  return { from: (t: string) => make(t), updates, inserts, deletes, isCalls };
}

function sessionUser(user: Record<string, unknown>) {
  mockedCookieClient.mockResolvedValue({
    auth: { getUser: () => Promise.resolve({ data: { user } }) },
  } as never);
}

const ORIGINAL_ADMIN_EMAILS = process.env.ADMIN_EMAILS;

beforeEach(() => {
  mockedAdminClient.mockReset();
  mockedCookieClient.mockReset();
  mockedOtpMailer.mockReset();
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
});

afterEach(() => {
  process.env.ADMIN_EMAILS = ORIGINAL_ADMIN_EMAILS;
});

describe("getCurrentPerson — Ghost-Verknüpfung nur mit Anker", () => {
  const ghostLookups = () => ({
    personsSeq: [
      { data: null, error: null }, // 1. noch nicht verlinkt
      { data: { id: GHOST_ID, auth_user_id: null }, error: null }, // 2. Ghost unverlinkt
    ],
    personsPrivate: { data: { person_id: GHOST_ID, email: GHOST_EMAIL }, error: null },
    updateSingle: { data: { id: GHOST_ID, auth_user_id: AUTH_UID }, error: null },
  });

  it("verknüpft den Ghost, wenn der Anker zur E-Mail passt (case-insensitiv)", async () => {
    sessionUser({ id: AUTH_UID, email: "Ghost@Example.de", app_metadata: { bordkasse_email: GHOST_EMAIL } });
    const db = makeDb(ghostLookups());
    mockedAdminClient.mockReturnValue(db as never);

    const res = await getCurrentPerson();

    expect(res?.id).toBe(GHOST_ID);
    expect(db.updates).toEqual([{ table: "persons", payload: { auth_user_id: AUTH_UID } }]);
    // Verknüpfung nur, solange die Person noch frei ist (gegen parallele Logins).
    expect(db.isCalls).toContainEqual({ table: "persons", mode: "update", col: "auth_user_id", val: null });
  });

  it("ohne Anker: kein Ghost-Link, keine Neuanlage, null", async () => {
    sessionUser({ id: AUTH_UID, email: GHOST_EMAIL, app_metadata: { provider: "email" } });
    const db = makeDb(ghostLookups());
    mockedAdminClient.mockReturnValue(db as never);

    const res = await getCurrentPerson();

    expect(res).toBeNull();
    expect(db.updates).toEqual([]);
    expect(db.inserts).toEqual([]);
  });

  it("Anker ≠ user.email (Adresse per GoTrue geändert): kein Ghost-Link", async () => {
    sessionUser({
      id: AUTH_UID,
      email: GHOST_EMAIL,
      app_metadata: { bordkasse_email: "angreifer@example.de" },
    });
    const db = makeDb(ghostLookups());
    mockedAdminClient.mockReturnValue(db as never);

    const res = await getCurrentPerson();

    expect(res).toBeNull();
    expect(db.updates).toEqual([]);
    expect(db.inserts).toEqual([]);
  });

  it("Ghost schon mit einem ANDEREN Konto verknüpft → null, keine Neuanlage", async () => {
    sessionUser({ id: AUTH_UID, email: GHOST_EMAIL, app_metadata: { bordkasse_email: GHOST_EMAIL } });
    const db = makeDb({
      personsSeq: [
        { data: null, error: null }, // 1. dieses Konto nicht verlinkt
        { data: null, error: null }, // 2. Ghost nicht mehr frei
        { data: null, error: null }, // Nachprüfung: auch nicht parallel mit diesem Konto verlinkt
      ],
      personsPrivate: { data: { person_id: GHOST_ID, email: GHOST_EMAIL }, error: null },
      insertSingle: { data: { id: NEW_ID }, error: null },
    });
    mockedAdminClient.mockReturnValue(db as never);

    const res = await getCurrentPerson();

    expect(res).toBeNull();
    expect(db.updates).toEqual([]);
    expect(db.inserts).toEqual([]);
  });

  it("paralleler Request hat schon verknüpft → Person wird trotzdem geliefert", async () => {
    sessionUser({ id: AUTH_UID, email: GHOST_EMAIL, app_metadata: { bordkasse_email: GHOST_EMAIL } });
    const db = makeDb({
      personsSeq: [
        { data: null, error: null },
        { data: null, error: null },
        { data: { id: GHOST_ID, auth_user_id: AUTH_UID }, error: null },
      ],
      personsPrivate: { data: { person_id: GHOST_ID, email: GHOST_EMAIL }, error: null },
    });
    mockedAdminClient.mockReturnValue(db as never);

    const res = await getCurrentPerson();

    expect(res?.id).toBe(GHOST_ID);
  });

  it("bereits verlinktes Konto bleibt unabhängig vom Anker erreichbar (Schritt 1)", async () => {
    sessionUser({ id: AUTH_UID, email: GHOST_EMAIL, app_metadata: {} });
    const db = makeDb({
      personsSeq: [{ data: { id: GHOST_ID, auth_user_id: AUTH_UID }, error: null }],
      personsPrivate: { data: { email: GHOST_EMAIL }, error: null },
    });
    mockedAdminClient.mockReturnValue(db as never);

    const res = await getCurrentPerson();

    expect(res?.id).toBe(GHOST_ID);
    expect(res?.email).toBe(GHOST_EMAIL);
  });
});

describe("getCurrentPerson — Neuanlage (Schritt 3) nur für ADMIN_EMAILS", () => {
  it("Nicht-Admin mit gültigem Anker, aber ohne Ghost → null, nichts angelegt", async () => {
    const email = "neu@example.de";
    sessionUser({ id: AUTH_UID, email, app_metadata: { bordkasse_email: email } });
    const db = makeDb({
      insertSingle: { data: { id: NEW_ID, auth_user_id: AUTH_UID }, error: null },
    });
    mockedAdminClient.mockReturnValue(db as never);

    const res = await getCurrentPerson();

    expect(res).toBeNull();
    expect(db.inserts).toEqual([]);
  });

  it("Admin-Adresse mit Anker → Person + persons_private werden angelegt", async () => {
    sessionUser({ id: AUTH_UID, email: ADMIN_EMAIL, app_metadata: { bordkasse_email: ADMIN_EMAIL } });
    const db = makeDb({
      insertSingle: { data: { id: NEW_ID, auth_user_id: AUTH_UID }, error: null },
    });
    mockedAdminClient.mockReturnValue(db as never);

    const res = await getCurrentPerson();

    expect(res?.id).toBe(NEW_ID);
    expect(res?.email).toBe(ADMIN_EMAIL);
    expect(db.inserts.map((i) => i.table)).toEqual(["persons", "persons_private"]);
  });

  it("scheitert der persons_private-Insert → null (kein isAdmin im ersten Request) + Kompensation", async () => {
    sessionUser({ id: AUTH_UID, email: ADMIN_EMAIL, app_metadata: { bordkasse_email: ADMIN_EMAIL } });
    const db = makeDb({
      insertSingle: { data: { id: NEW_ID, auth_user_id: AUTH_UID }, error: null },
      privInsert: { data: null, error: { code: "23505", message: "dup" } },
    });
    mockedAdminClient.mockReturnValue(db as never);

    const res = await getCurrentPerson();

    expect(res).toBeNull();
    expect(db.deletes).toEqual([{ table: "persons" }]);
  });
});

describe("sendInvitationMagicLink — Konto vor OTP, shouldCreateUser: false", () => {
  const createUser = vi.fn();
  const listUsers = vi.fn();
  const updateUserById = vi.fn();
  const deleteUser = vi.fn();
  const signInWithOtp = vi.fn();
  const order: string[] = [];

  beforeEach(() => {
    order.length = 0;
    createUser.mockReset().mockImplementation(async () => {
      order.push("createUser");
      return { data: { user: { id: "u" } }, error: null };
    });
    listUsers.mockReset().mockResolvedValue({ data: { users: [] }, error: null });
    updateUserById.mockReset().mockResolvedValue({ data: { user: { id: "u" } }, error: null });
    signInWithOtp.mockReset().mockImplementation(async () => {
      order.push("otp");
      return { error: null };
    });
    deleteUser.mockReset().mockResolvedValue({ data: {}, error: null });
    mockedAdminClient.mockReturnValue({
      auth: { admin: { createUser, listUsers, updateUserById, deleteUser } },
      // Verknüpfungsprüfung: Konto ist mit keiner Person verknüpft.
      from: () => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = () => b;
        b.maybeSingle = async () => ({ data: null, error: null });
        return b;
      },
    } as never);
    mockedOtpMailer.mockReturnValue({ auth: { signInWithOtp } } as never);
  });

  it("legt das Konto mit Anker an und verschickt danach den OTP ohne Kontoanlage", async () => {
    const res = await sendInvitationMagicLink(GHOST_EMAIL, "https://app.example");

    expect(res.ok).toBe(true);
    expect(createUser).toHaveBeenCalledWith({
      email: GHOST_EMAIL,
      email_confirm: true,
      app_metadata: { bordkasse_email: GHOST_EMAIL },
    });
    expect(order).toEqual(["createUser", "otp"]);
    const arg = signInWithOtp.mock.calls[0][0] as { options: { shouldCreateUser?: boolean } };
    expect(arg.options.shouldCreateUser).toBe(false);
  });

  it("email_exists, unverknüpftes Konto ohne Anker → gelöscht + neu angelegt, dann OTP (Grill B1)", async () => {
    createUser
      .mockImplementationOnce(async () => {
        order.push("createUser");
        return { data: { user: null }, error: { code: "email_exists", message: "x" } };
      })
      .mockImplementation(async () => {
        order.push("createUser");
        return { data: { user: { id: "u-neu" } }, error: null };
      });
    deleteUser.mockImplementation(async () => {
      order.push("deleteUser");
      return { data: {}, error: null };
    });
    listUsers.mockResolvedValue({
      data: { users: [{ id: "u-alt", email: GHOST_EMAIL, app_metadata: {}, email_confirmed_at: null }] },
      error: null,
    });

    const res = await sendInvitationMagicLink(GHOST_EMAIL, "https://app.example");

    expect(res.ok).toBe(true);
    expect(updateUserById).not.toHaveBeenCalled();
    expect(order).toEqual(["createUser", "deleteUser", "createUser", "otp"]);
  });

  it("email_exists, Konto mit fremdem Anker → Einladung scheitert ohne Mail, wenn Zurücksetzen und Parken scheitern", async () => {
    createUser.mockResolvedValue({ data: { user: null }, error: { code: "email_exists", message: "x" } });
    listUsers.mockResolvedValue({
      data: { users: [{ id: "u-b", email: GHOST_EMAIL, app_metadata: { bordkasse_email: "b@example.test" } }] },
      error: null,
    });
    updateUserById.mockResolvedValue({ data: null, error: { code: "email_exists" } });

    const res = await sendInvitationMagicLink(GHOST_EMAIL, "https://app.example");

    expect(res.ok).toBe(false);
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  it("anderer Fehler bei der Kontoanlage → keine Mail, ok: false", async () => {
    createUser.mockResolvedValue({ data: { user: null }, error: { code: "unexpected_failure", message: "x" } });

    const res = await sendInvitationMagicLink(GHOST_EMAIL, "https://app.example");

    expect(res.ok).toBe(false);
    expect(signInWithOtp).not.toHaveBeenCalled();
  });
});
