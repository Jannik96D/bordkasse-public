// Slice 10 (Sicherheitsrunde 2026-11): Mail-Aktionen drosseln, verwaiste
// Auth-Konten aufräumen. (Der Mindestabstand für resendSettlement steht in
// settlement-claim.test.ts.)
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "./helpers/fake-supabase";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue(new Map()) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/authz", () => ({
  requireMember: vi.fn(),
  requireSkipperOrAdmin: vi.fn(),
  isAdmin: vi.fn(),
}));
vi.mock("@/lib/auth/get-current-person", () => ({ getCurrentPerson: vi.fn() }));
vi.mock("@/lib/auth/invite", () => ({ sendInvitationMagicLink: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock("@/lib/auth/origin", () => ({
  resolveOrigin: vi.fn().mockReturnValue("https://example.test"),
  appOrigin: vi.fn().mockReturnValue("https://example.test"),
}));
vi.mock("@/lib/email/send", () => ({ sendMails: vi.fn(), sendMail: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/notify/web-push", () => ({ sendPushToPersons: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/email/send-payment-pending", () => ({ sendPaymentPendingMail: vi.fn().mockResolvedValue({ ok: true }) }));

import { toggleDebtSettled } from "@/lib/actions/settled-debts";
import { updateMember } from "@/lib/actions/trip-members";
import { submitSelfPayment } from "@/lib/actions/prepayments";
import { inviteMember } from "@/lib/actions/trip-members";
import { cleanupOrphanAuthUsers } from "@/lib/auth/orphan-accounts";
import { INVITE_LIMIT_MESSAGE, inviteGlobalLimitKey, inviteLimitKey } from "@/lib/auth/action-rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdmin, requireMember, requireSkipperOrAdmin } from "@/lib/auth/authz";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { sendInvitationMagicLink } from "@/lib/auth/invite";
import { sendMails } from "@/lib/email/send";
import { sendPaymentPendingMail } from "@/lib/email/send-payment-pending";

const TRIP = "aaaaaaaa-0000-4000-8000-000000000001";
const DEBTOR = "aaaaaaaa-0000-4000-8000-000000000002";
const CREDITOR = "aaaaaaaa-0000-4000-8000-000000000003";
const TRANCHE = "aaaaaaaa-0000-4000-8000-000000000004";
const KEY = "bbbbbbbb-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendMails).mockImplementation(async (msgs) => msgs.map(() => ({ ok: true })) as never);
  vi.mocked(sendInvitationMagicLink).mockResolvedValue({ ok: true } as never);
});

describe("toggleDebtSettled — mailt nur beim Wechsel offen → bezahlt", () => {
  function setup() {
    const fake = createFakeSupabase({
      trips: [{ id: TRIP, name: "T", start_date: "2026-06-01", end_date: "2026-06-10", skipper_id: CREDITOR, trip_type: "sailing", settlement_announced_at: "2026-06-11T10:00:00Z" }],
      prepayment_plan: [],
      persons: [
        { id: DEBTOR, display_name: "Anna" },
        { id: CREDITOR, display_name: "Ben" },
      ],
      persons_private: [
        { person_id: DEBTOR, email: "anna@example.test" },
        { person_id: CREDITOR, email: "ben@example.test" },
      ],
      settled_debts: [],
      audit_log: [],
    });
    fake.onRpc("simplify_debts", () => ({ data: [{ from_person_id: DEBTOR, to_person_id: CREDITOR, amount: 10 }] }));
    // Benachrichtigungs-Limit: 10 pro Schlüssel (wie die echte Funktion, ein Fenster).
    const counts = new Map<string, number>();
    fake.onRpc("bump_login_rate_limit", (args) => {
      const k = String(args.p_key);
      const n = (counts.get(k) ?? 0) + 1;
      counts.set(k, n);
      return { data: n <= Number(args.p_max) };
    });
    vi.mocked(createAdminClient).mockReturnValue(fake.client as never);
    vi.mocked(requireMember).mockResolvedValue({ ok: true, personId: DEBTOR } as never);
    vi.mocked(isAdmin).mockResolvedValue(false);
    return fake;
  }
  const input = { tripId: TRIP, fromPersonId: DEBTOR, toPersonId: CREDITOR, amount: 10, settled: true };
  const mailsSent = () => vi.mocked(sendMails).mock.calls.reduce((n, c) => n + (c[0] as unknown[]).length, 0);

  it("erstes Setzen mailt, erneutes Setzen derselben Schuld mailt NICHT noch einmal", async () => {
    const fake = setup();
    const first = await toggleDebtSettled(input);
    expect(first.ok).toBe(true);
    expect(first.notified).toBe(true);
    expect(mailsSent()).toBe(2); // Schuldner + Gläubiger
    const auditAfterFirst = fake.rows("audit_log").length;

    const again = await toggleDebtSettled(input);
    expect(again.ok).toBe(true);
    // UI zeigt dann neutral „Als bezahlt markiert" statt „… benachrichtigt".
    expect(again.notified).toBe(false);
    expect(mailsSent()).toBe(2); // unverändert
    expect(fake.rows("settled_debts")).toHaveLength(1);
    expect(fake.rows("audit_log")).toHaveLength(auditAfterFirst);
  });

  it("nach Zurücknehmen und erneutem Setzen mailt der echte Wechsel wieder", async () => {
    setup();
    await toggleDebtSettled(input);
    await toggleDebtSettled({ ...input, settled: false });
    expect(mailsSent()).toBe(2); // Zurücknehmen mailt nicht
    await toggleDebtSettled(input);
    expect(mailsSent()).toBe(4);
  });
});

describe("toggleDebtSettled — Häkchen-Spam (Limit auf Benachrichtigungen)", () => {
  const input = { tripId: TRIP, fromPersonId: DEBTOR, toPersonId: CREDITOR, amount: 10, settled: true };
  function setup(allow: boolean) {
    const fake = createFakeSupabase({
      trips: [{ id: TRIP, name: "T", start_date: "2026-06-01", end_date: "2026-06-10", skipper_id: CREDITOR, trip_type: "sailing", settlement_announced_at: "2026-06-11T10:00:00Z" }],
      prepayment_plan: [],
      persons: [{ id: DEBTOR, display_name: "Anna" }, { id: CREDITOR, display_name: "Ben" }],
      persons_private: [{ person_id: DEBTOR, email: "anna@example.test" }, { person_id: CREDITOR, email: "ben@example.test" }],
      settled_debts: [],
      audit_log: [],
    });
    fake.onRpc("simplify_debts", () => ({ data: [{ from_person_id: DEBTOR, to_person_id: CREDITOR, amount: 10 }] }));
    fake.onRpc("bump_login_rate_limit", () => ({ data: allow }));
    vi.mocked(createAdminClient).mockReturnValue(fake.client as never);
    vi.mocked(requireMember).mockResolvedValue({ ok: true, personId: DEBTOR } as never);
    vi.mocked(isAdmin).mockResolvedValue(false);
    return fake;
  }

  it("über dem Limit: Häkchen wird gespeichert, aber keine Mail/Push und kein Fehler", async () => {
    const fake = setup(false);
    const res = await toggleDebtSettled(input);
    expect(res.ok).toBe(true);
    expect(res.notified).toBe(false);
    expect(fake.rows("settled_debts")).toHaveLength(1);
    expect(sendMails).not.toHaveBeenCalled();
  });

  it("zählt unter debt-mail:<Akteur>:<Törn> mit 10 pro Stunde", async () => {
    const fake = setup(true);
    await toggleDebtSettled(input);
    const call = fake.rpcCalls.find((c) => c.name === "bump_login_rate_limit");
    expect(call?.args).toEqual({ p_key: `debt-mail:${DEBTOR}:${TRIP}`, p_max: 10, p_window_seconds: 3600 });
  });

  it("der 11. echte Wechsel (bezahlt → offen → bezahlt im Kreis) mailt nicht mehr", async () => {
    const fake = createFakeSupabase({
      trips: [{ id: TRIP, name: "T", start_date: "2026-06-01", end_date: "2026-06-10", skipper_id: CREDITOR, trip_type: "sailing", settlement_announced_at: "2026-06-11T10:00:00Z" }],
      prepayment_plan: [],
      persons: [{ id: DEBTOR, display_name: "Anna" }, { id: CREDITOR, display_name: "Ben" }],
      persons_private: [{ person_id: DEBTOR, email: "anna@example.test" }, { person_id: CREDITOR, email: "ben@example.test" }],
      settled_debts: [],
      audit_log: [],
    });
    fake.onRpc("simplify_debts", () => ({ data: [{ from_person_id: DEBTOR, to_person_id: CREDITOR, amount: 10 }] }));
    let n = 0;
    fake.onRpc("bump_login_rate_limit", (args) => ({ data: ++n <= Number(args.p_max) }));
    vi.mocked(createAdminClient).mockReturnValue(fake.client as never);
    vi.mocked(requireMember).mockResolvedValue({ ok: true, personId: DEBTOR } as never);
    vi.mocked(isAdmin).mockResolvedValue(false);
    for (let i = 0; i < 12; i++) {
      await toggleDebtSettled(input);
      await toggleDebtSettled({ ...input, settled: false });
    }
    const sent = vi.mocked(sendMails).mock.calls.length;
    expect(sent).toBe(10);
  });
});

describe("submitSelfPayment — Idempotency-Key", () => {
  function setup() {
    const fake = createFakeSupabase({
      trips: [{ id: TRIP, archived: false, skipper_id: CREDITOR, name: "T" }],
      prepayment_plan: [{ trip_id: TRIP, advancer_person_id: CREDITOR }],
      prepayment_tranches: [{ id: TRANCHE, trip_id: TRIP, label: "Endzahlung" }],
      transactions: [],
      audit_log: [],
    });
    vi.mocked(createAdminClient).mockReturnValue(fake.client as never);
    vi.mocked(getCurrentPerson).mockResolvedValue({ id: DEBTOR, display_name: "Anna" } as never);
    vi.mocked(requireMember).mockResolvedValue({ ok: true, personId: DEBTOR } as never);
    return fake;
  }
  function form(key?: string) {
    const fd = new FormData();
    fd.set("trip_id", TRIP);
    fd.set("tranche_id", TRANCHE);
    fd.set("amount", "50,00");
    fd.set("date", "2026-06-07");
    if (key) fd.set("idempotency_key", key);
    return fd;
  }

  it("Doppelklick/Retry mit demselben Key legt EINE Meldung an und mailt EINMAL", async () => {
    const fake = setup();
    const a = await submitSelfPayment({ status: "idle" }, form(KEY));
    const b = await submitSelfPayment({ status: "idle" }, form(KEY));
    expect(a).toEqual({ status: "ok" });
    expect(b).toEqual({ status: "ok" });
    expect(fake.rows("transactions")).toHaveLength(1);
    expect(sendPaymentPendingMail).toHaveBeenCalledTimes(1);
  });

  it("derselbe Key mit abweichendem Betrag ist KEIN stilles ok", async () => {
    const fake = setup();
    await submitSelfPayment({ status: "idle" }, form(KEY));
    const fd = form(KEY);
    fd.set("amount", "60,00");
    const res = await submitSelfPayment({ status: "idle" }, fd);
    expect(res.status).toBe("error");
    expect(fake.rows("transactions")).toHaveLength(1);
  });

  it("zwei bewusst getrennte Meldungen (anderer Key) bleiben möglich", async () => {
    const fake = setup();
    await submitSelfPayment({ status: "idle" }, form(KEY));
    await submitSelfPayment({ status: "idle" }, form("bbbbbbbb-0000-4000-8000-000000000002"));
    expect(fake.rows("transactions")).toHaveLength(2);
  });

  it("ohne Key wird abgewiesen (kein ungeschützter Pfad)", async () => {
    const fake = setup();
    const res = await submitSelfPayment({ status: "idle" }, form());
    expect(res.status).toBe("error");
    expect(fake.rows("transactions")).toHaveLength(0);
  });

  it("ein Key, der zu einer fremden Buchung gehört, wird nicht als Duplikat durchgewunken", async () => {
    const fake = setup();
    fake.rows("transactions").push({
      id: "t-foreign",
      trip_id: TRIP,
      type: "credit",
      credit_from: CREDITOR,
      tranche_id: TRANCHE,
      idempotency_key: KEY,
    });
    const res = await submitSelfPayment({ status: "idle" }, form(KEY));
    expect(res.status).toBe("error");
    expect(sendPaymentPendingMail).not.toHaveBeenCalled();
  });
});

describe("inviteMember — Limit pro (Akteur, Törn)", () => {
  function setup(limitAllows: boolean) {
    const fake = createFakeSupabase({
      trips: [{ id: TRIP, archived: false }],
      persons: [],
      persons_private: [],
      trip_members: [],
      audit_log: [],
    });
    fake.onRpc("bump_login_rate_limit", () => ({ data: limitAllows }));
    vi.mocked(createAdminClient).mockReturnValue(fake.client as never);
    vi.mocked(requireSkipperOrAdmin).mockResolvedValue({ ok: true, personId: CREDITOR } as never);
    return fake;
  }
  function form() {
    const fd = new FormData();
    fd.set("trip_id", TRIP);
    fd.set("email", "neu@example.test");
    fd.set("display_name", "Neu");
    return fd;
  }

  it("über dem Limit: neutrale Meldung, nichts angelegt, keine Mail", async () => {
    const fake = setup(false);
    const res = await inviteMember({ status: "idle" }, form());
    expect(res).toEqual({ status: "error", message: INVITE_LIMIT_MESSAGE });
    expect(fake.rows("persons")).toHaveLength(0);
    expect(fake.rows("trip_members")).toHaveLength(0);
    expect(sendInvitationMagicLink).not.toHaveBeenCalled();
  });

  it("zählt unter dem Schlüssel invite:<Akteur>:<Törn> mit 30 pro Stunde", async () => {
    const fake = setup(true);
    await inviteMember({ status: "idle" }, form());
    const call = fake.rpcCalls.find((c) => c.name === "bump_login_rate_limit");
    expect(call?.args).toEqual({ p_key: inviteLimitKey(CREDITOR, TRIP), p_max: 30, p_window_seconds: 3600 });
    expect(inviteLimitKey(CREDITOR, TRIP)).toBe(`invite:${CREDITOR}:${TRIP}`);
    expect(sendInvitationMagicLink).toHaveBeenCalledTimes(1);
  });

  it("zählt zusätzlich global je Akteur (invite:<akteur>, 60/h) und blockiert darüber", async () => {
    const fake = setup(true);
    fake.onRpc("bump_login_rate_limit", (args) => ({ data: args.p_key !== inviteGlobalLimitKey(CREDITOR) }));
    const res = await inviteMember({ status: "idle" }, form());
    expect(res).toEqual({ status: "error", message: INVITE_LIMIT_MESSAGE });
    const call = fake.rpcCalls.find((c) => (c.args as { p_key: string }).p_key === `invite:${CREDITOR}`);
    expect(call?.args).toEqual({ p_key: `invite:${CREDITOR}`, p_max: 60, p_window_seconds: 3600 });
    expect(fake.rows("persons")).toHaveLength(0);
  });

  it("fail-open: scheitert der Zähler, wird die Crew-Anlage NICHT blockiert", async () => {
    const fake = setup(true);
    fake.onRpc("bump_login_rate_limit", () => ({ error: { message: "db down" } }));
    const res = await inviteMember({ status: "idle" }, form());
    expect(res.status).toBe("ok");
    expect(fake.rows("trip_members")).toHaveLength(1);
  });
});

describe("updateMember — Einladungs-Limit bei erster E-Mail eines Ghosts", () => {
  const MEMBER = "aaaaaaaa-0000-4000-8000-0000000000a1";
  const GHOST = "aaaaaaaa-0000-4000-8000-0000000000a2";
  function setup(limitAllows: boolean) {
    const fake = createFakeSupabase({
      trips: [{ id: TRIP, archived: false, skipper_id: CREDITOR }],
      trip_members: [
        {
          id: MEMBER,
          trip_id: TRIP,
          person_id: GHOST,
          on_board_from: null,
          on_board_to: null,
          is_alcoholic: null,
          persons: { auth_user_id: null, display_name: "Ghost" },
        },
      ],
      persons: [{ id: GHOST, auth_user_id: null, display_name: "Ghost" }],
      persons_private: [],
      audit_log: [],
    });
    fake.onRpc("bump_login_rate_limit", () => ({ data: limitAllows }));
    vi.mocked(createAdminClient).mockReturnValue(fake.client as never);
    vi.mocked(requireSkipperOrAdmin).mockResolvedValue({ ok: true, personId: CREDITOR } as never);
    vi.mocked(isAdmin).mockResolvedValue(true);
    return fake;
  }
  function form() {
    const fd = new FormData();
    fd.set("member_id", MEMBER);
    fd.set("trip_id", TRIP);
    fd.set("display_name", "Ghost");
    fd.set("email", "ghost@example.test");
    return fd;
  }

  it("unter dem Limit geht die Einladung raus", async () => {
    const fake = setup(true);
    const res = await updateMember({ status: "idle" }, form());
    expect(res.status).toBe("ok");
    expect(fake.rows("persons_private")).toHaveLength(1);
    expect(sendInvitationMagicLink).toHaveBeenCalledTimes(1);
  });

  it("über dem Limit bleibt die Adresse gespeichert, der Link wird nicht verschickt", async () => {
    const fake = setup(false);
    const res = await updateMember({ status: "idle" }, form());
    expect(res.status).toBe("ok");
    expect(fake.rows("persons_private")).toHaveLength(1);
    expect(sendInvitationMagicLink).not.toHaveBeenCalled();
  });
});

describe("cleanupOrphanAuthUsers", () => {
  const NOW = Date.parse("2026-11-26T12:00:00Z");
  const old = "2026-05-01T00:00:00Z";
  const young = "2026-11-25T00:00:00Z";
  type U = {
    id: string;
    email: string;
    created_at: string;
    last_sign_in_at?: string | null;
    app_metadata?: Record<string, unknown>;
  };
  const user = (id: string, email: string, extra: Partial<U> = {}): U => ({
    id,
    email,
    created_at: old,
    last_sign_in_at: null,
    app_metadata: { bordkasse_email: email },
    ...extra,
  });

  function setup(users: U[], persons: Array<{ id: string; auth_user_id: string | null }>, priv: string[]) {
    const fake = createFakeSupabase({
      persons,
      persons_private: priv.map((email, i) => ({ person_id: `p${i}`, email })),
    });
    const deleteUser = vi.fn().mockResolvedValue({ error: null });
    const listUsers = vi.fn().mockResolvedValue({ data: { users }, error: null });
    const admin = Object.assign({}, fake.client, { auth: { admin: { listUsers, deleteUser } } });
    return { admin: admin as never, deleteUser, listUsers };
  }

  it("löscht nur alte Konten ohne Person und ohne persons_private-Eintrag", async () => {
    const { admin, deleteUser } = setup(
      [
        user("orphan", "orphan@example.test"),
        user("linked", "linked@example.test"),
        user("invited", "Invited@Example.test"),
        user("anchored", "geaendert@example.test", { app_metadata: { bordkasse_email: "anker@example.test" } }),
        user("young", "young@example.test", { created_at: young }),
        user("recent-login", "login@example.test", { last_sign_in_at: young }),
      ],
      [{ id: "pp", auth_user_id: "linked" }],
      ["invited@example.test", "anker@example.test"],
    );
    const res = await cleanupOrphanAuthUsers(admin, NOW);
    expect(res).toEqual({ deleted: 1, failed: 0 });
    expect(deleteUser).toHaveBeenCalledTimes(1);
    expect(deleteUser).toHaveBeenCalledWith("orphan");
  });

  it("altes Konto OHNE Anker, dessen Konto-Adresse in persons_private steht, bleibt", async () => {
    const { admin, deleteUser } = setup(
      [user("noanchor", "Eingeladen@Example.test", { app_metadata: undefined })],
      [],
      ["eingeladen@example.test"],
    );
    const res = await cleanupOrphanAuthUsers(admin, NOW);
    expect(res).toEqual({ deleted: 0, failed: 0 });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("Konten von ADMIN_EMAILS bleiben auch ohne Person stehen", async () => {
    process.env.ADMIN_EMAILS = "admin@example.test";
    try {
      const { admin, deleteUser } = setup([user("adm", "Admin@Example.test")], [], []);
      const res = await cleanupOrphanAuthUsers(admin, NOW);
      expect(res).toEqual({ deleted: 0, failed: 0 });
      expect(deleteUser).not.toHaveBeenCalled();
    } finally {
      delete process.env.ADMIN_EMAILS;
    }
  });

  it("fail-closed: scheitert eine Abfrage, wird NICHTS gelöscht", async () => {
    const fake = createFakeSupabase({ persons: [], persons_private: [] });
    fake.failOn({ table: "persons_private", action: "select" });
    const deleteUser = vi.fn().mockResolvedValue({ error: null });
    const listUsers = vi.fn().mockResolvedValue({ data: { users: [user("orphan", "o@example.test")] }, error: null });
    const admin = Object.assign({}, fake.client, { auth: { admin: { listUsers, deleteUser } } });
    const res = await cleanupOrphanAuthUsers(admin as never, NOW);
    expect(res).toEqual({ deleted: 0, failed: 1 });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("ein Löschfehler zählt separat und bricht die übrigen nicht ab", async () => {
    const { admin, deleteUser } = setup([user("a", "a@example.test"), user("b", "b@example.test")], [], []);
    deleteUser.mockResolvedValueOnce({ error: { code: "boom" } }).mockResolvedValue({ error: null });
    const res = await cleanupOrphanAuthUsers(admin, NOW);
    expect(res).toEqual({ deleted: 1, failed: 1 });
    expect(deleteUser).toHaveBeenCalledTimes(2);
  });
});
