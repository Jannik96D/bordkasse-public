// Sanierungsplan D3: archivierte Törns (`trips.archived`) sind ab jetzt
// schreibgeschützt. Der zentrale Guard `assertTripNotArchived`
// (lib/auth/trip-state.ts) wird NACH dem jeweiligen Auth-Guard (requireMember/
// requireSkipper/…) und VOR jeder Schreib-Operation aufgerufen.
//
// Diese Suite deckt JEDE geschützte Action mit einem Negativfall (archiviert
// → abgelehnt mit ARCHIVED_TRIP_MSG, KEINE Schreiboperation danach) ab.
// Für Actions, die bereits an anderer Stelle end-to-end getestet sind
// (createExpense, updateCredit, deleteTransaction, replayPendingTransaction,
// updateMember, replaceMember, savePrepaymentPlan, createCredit) und dort mit
// `archived` implizit undefined/false laufen, deckt dieser bestehende
// Testlauf bereits den Positivfall ab — hier kommt nur der fehlende
// Negativfall hinzu. Für Actions OHNE bestehende Tests (updateExpense,
// inviteMember, removeMember, setSkipperRole, saveTranches, recordPayment,
// submitSelfPayment, confirmSelfPayment, rejectSelfPayment, addCategory,
// removeCategory, setCategoryIcon) gibt es hier sowohl Positiv- als auch
// Negativfall.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map()) }));
vi.mock("@/lib/auth/origin", () => ({
  resolveOrigin: vi.fn(() => "https://bordkasse.dieter.ms"),
  appOrigin: vi.fn(() => "https://bordkasse.dieter.ms"),
}));
vi.mock("@/lib/auth/invite", () => ({ sendInvitationMagicLink: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/notify/web-push", () => ({ sendPushToPersons: vi.fn(async () => undefined) }));
vi.mock("@/lib/notify/recipients", () => ({ pushRecipients: vi.fn(() => []) }));
vi.mock("@/lib/notify/payloads", () => ({
  paymentPendingPush: vi.fn(() => ({})),
  paymentConfirmedPush: vi.fn(() => ({})),
  paymentRejectedPush: vi.fn(() => ({})),
}));
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
  updateExpense,
  updateCredit,
  deleteTransaction,
  replayPendingTransaction,
} from "@/lib/actions/transactions";
import { inviteMember, removeMember, updateMember, setSkipperRole } from "@/lib/actions/trip-members";
import {
  savePrepaymentPlan,
  saveTranches,
  recordPayment,
  replaceMember,
  submitSelfPayment,
  confirmSelfPayment,
  rejectSelfPayment,
} from "@/lib/actions/prepayments";
import { addCategory, removeCategory, setCategoryIcon } from "@/lib/actions/categories";
import { setDepositSettled } from "@/lib/actions/trip-checklist";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import {
  requireMember,
  requireSkipperOrAdmin,
  requireSkipperAdminOrAdvancer,
  isAdmin,
} from "@/lib/auth/authz";
import { createAdminClient } from "@/lib/supabase/admin";
import { ARCHIVED_TRIP_MSG } from "@/lib/auth/trip-state";

const mockedPerson = vi.mocked(getCurrentPerson);
const mockedRequireMember = vi.mocked(requireMember);
const mockedRequireSkipperOrAdmin = vi.mocked(requireSkipperOrAdmin);
const mockedAdvancer = vi.mocked(requireSkipperAdminOrAdvancer);
const mockedIsAdmin = vi.mocked(isAdmin);
const mockedAdminClient = vi.mocked(createAdminClient);

const TRIP_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const PERSON_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const OTHER_ID = "aaaaaaaa-0000-4000-8000-000000000003";
const TX_ID = "aaaaaaaa-0000-4000-8000-000000000004";
const MEMBER_ID = "aaaaaaaa-0000-4000-8000-000000000005";
const TRANCHE_ID = "aaaaaaaa-0000-4000-8000-000000000006";
const CATEGORY_ID = "aaaaaaaa-0000-4000-8000-000000000007";

type TableBehavior = {
  data?: unknown;
  error?: unknown;
  list?: unknown[];
  count?: number;
};

/**
 * Generischer, tabellenbewusster Supabase-Mock: `.maybeSingle()`/`.single()`
 * liefern `data` (Default `null`), `.then()` (Query ohne Terminator, z. B.
 * count-Queries oder `.select().eq()`-Listen) liefert `{ data: list ?? [] }`.
 * `trips` liefert per Default `{ archived }` — der einzige Wert, den JEDER
 * Test hier tatsächlich braucht.
 */
function makeSupabase(archived: boolean, tables: Record<string, TableBehavior> = {}) {
  const calls: Array<{ table: string; op: string }> = [];
  const merged: Record<string, TableBehavior> = {
    trips: { data: { archived, skipper_id: OTHER_ID }, ...tables.trips },
    ...tables,
  };
  const make = (table: string) => {
    const behavior = merged[table] ?? {};
    const b: Record<string, unknown> = {};
    const self = () => b;
    b.select = self;
    b.eq = self;
    b.neq = self;
    b.in = self;
    b.is = self;
    b.not = self;
    b.or = self;
    b.insert = (...args: unknown[]) => {
      calls.push({ table, op: "insert" });
      void args;
      return b;
    };
    b.upsert = (...args: unknown[]) => {
      calls.push({ table, op: "upsert" });
      void args;
      return b;
    };
    b.update = (...args: unknown[]) => {
      calls.push({ table, op: "update" });
      void args;
      return b;
    };
    b.delete = () => {
      calls.push({ table, op: "delete" });
      return b;
    };
    b.maybeSingle = () => Promise.resolve({ data: behavior.data ?? null, error: behavior.error ?? null });
    b.single = () => Promise.resolve({ data: behavior.data ?? null, error: behavior.error ?? null });
    b.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve({
        data: behavior.list ?? [],
        count: behavior.count ?? (behavior.list?.length ?? 0),
        error: behavior.error ?? null,
      }).then(onFulfilled);
    return b;
  };
  return { supabase: { from: (table: string) => make(table), rpc: () => Promise.resolve({ error: null }) }, calls };
}

beforeEach(() => {
  mockedPerson.mockReset();
  mockedRequireMember.mockReset();
  mockedRequireSkipperOrAdmin.mockReset();
  mockedAdvancer.mockReset();
  mockedIsAdmin.mockReset();
  mockedAdminClient.mockReset();
  mockedPerson.mockResolvedValue({ id: PERSON_ID, display_name: "Crew", email: "c@x.de" } as never);
  mockedRequireMember.mockResolvedValue({ ok: true, personId: PERSON_ID });
  mockedRequireSkipperOrAdmin.mockResolvedValue({ ok: true, personId: PERSON_ID });
  mockedAdvancer.mockResolvedValue({ ok: true, personId: PERSON_ID });
  mockedIsAdmin.mockResolvedValue(false);
});

function expenseFormData(extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("trip_id", TRIP_ID);
  fd.set("date", "2026-06-07");
  fd.set("description", "Testausgabe");
  fd.set("paid_by", PERSON_ID);
  fd.set("amount", "10,00");
  fd.set("split_type", "equal");
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

function creditFormData(extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("trip_id", TRIP_ID);
  fd.set("date", "2026-06-07");
  fd.set("description", "Gutschrift");
  fd.set("amount", "10,00");
  fd.set("credit_from", PERSON_ID);
  fd.set("credit_to", OTHER_ID);
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

describe("createExpense — archivierter Törn (D3)", () => {
  it("lehnt eine neue Ausgabe ab", async () => {
    const { supabase } = makeSupabase(true);
    mockedAdminClient.mockReturnValue(supabase as never);
    const res = await createExpense({ status: "idle" }, expenseFormData());
    expect(res).toEqual({ status: "error", message: ARCHIVED_TRIP_MSG });
  });
});

describe("createCredit — archivierter Törn (D3)", () => {
  it("lehnt eine neue Gutschrift ab", async () => {
    const { supabase } = makeSupabase(true);
    mockedAdminClient.mockReturnValue(supabase as never);
    const res = await createCredit({ status: "idle" }, creditFormData());
    expect(res).toEqual({ status: "error", message: ARCHIVED_TRIP_MSG });
  });
});

describe("updateExpense — archivierter Törn (D3)", () => {
  const existing = {
    created_by: OTHER_ID,
    type: "expense",
    trip_id: TRIP_ID,
    deleted_at: null,
    description: "Alt",
    category_id: null,
    date: "2026-06-01",
    paid_by: PERSON_ID,
    amount: 5,
    alcohol_amount: 0,
    tip_amount: 0,
    tip_distribution: "proportional",
    split_type: "equal",
    tranche_id: null,
    original_currency: null,
    original_amount: null,
    exchange_rate: null,
    rate_source: null,
    rate_confirmed_at: null,
  };

  function formDataWithTxId(archived: boolean) {
    const fd = expenseFormData();
    fd.set("transaction_id", TX_ID);
    const { supabase } = makeSupabase(archived, {
      transactions: { data: existing },
      transaction_participants: { list: [] },
    });
    mockedAdminClient.mockReturnValue(supabase as never);
    return fd;
  }

  it("lehnt eine Änderung ab, wenn der Törn archiviert ist", async () => {
    // Ersteller (OTHER_ID) != aktuelle Person → canEditTransaction fällt auf
    // requireSkipperOrAdmin zurück, das hier ok ist (Skipper editiert).
    const fd = formDataWithTxId(true);
    const res = await updateExpense({ status: "idle" }, fd);
    expect(res).toEqual({ status: "error", message: ARCHIVED_TRIP_MSG });
  });

  it("lässt eine Änderung an einem NICHT archivierten Törn durch den Guard (Positivfall)", async () => {
    const fd = formDataWithTxId(false);
    const res = await updateExpense({ status: "idle" }, fd);
    // redirect() wirft in echtem Next.js — hier ist es ein No-Op-Mock, das
    // NEXT_REDIRECT wirft (siehe vi.mock("next/navigation")). Entscheidend:
    // die Funktion kommt bis zum Redirect, NICHT bis zum Archiv-Fehler.
    expect(res).not.toEqual({ status: "error", message: ARCHIVED_TRIP_MSG });
  });
});

describe("updateCredit — archivierter Törn (D3)", () => {
  const existing = {
    created_by: PERSON_ID,
    type: "credit",
    trip_id: TRIP_ID,
    deleted_at: null,
    amount: 10,
    credit_from: PERSON_ID,
    credit_to: OTHER_ID,
    tranche_id: null,
  };

  it("lehnt eine Änderung ab", async () => {
    const fd = creditFormData();
    fd.set("transaction_id", TX_ID);
    const { supabase } = makeSupabase(true, { transactions: { data: existing } });
    mockedAdminClient.mockReturnValue(supabase as never);
    const res = await updateCredit({ status: "idle" }, fd);
    expect(res).toEqual({ status: "error", message: ARCHIVED_TRIP_MSG });
  });
});

describe("deleteTransaction — archivierter Törn (D3)", () => {
  it("lehnt das Löschen ab", async () => {
    const { supabase } = makeSupabase(true, {
      transactions: { data: { category_id: null, trip_id: TRIP_ID, created_by: PERSON_ID } },
    });
    mockedAdminClient.mockReturnValue(supabase as never);
    const res = await deleteTransaction(TX_ID, TRIP_ID);
    expect(res).toEqual({ ok: false, wasKaution: false });
  });

  it("erlaubt das Löschen weiterhin an einem NICHT archivierten Törn (Positivfall)", async () => {
    const { supabase } = makeSupabase(false, {
      transactions: { data: { category_id: null, trip_id: TRIP_ID, created_by: PERSON_ID } },
    });
    mockedAdminClient.mockReturnValue(supabase as never);
    const res = await deleteTransaction(TX_ID, TRIP_ID);
    expect(res.ok).toBe(true);
  });
});

describe("replayPendingTransaction — archivierter Törn (D3)", () => {
  it("lehnt den Replay einer Ausgabe ab, mit klarer Meldung statt stillem Erfolg", async () => {
    const { supabase } = makeSupabase(true);
    mockedAdminClient.mockReturnValue(supabase as never);
    const res = await replayPendingTransaction("expense", {
      trip_id: TRIP_ID,
      date: "2026-06-07",
      description: "Offline",
      paid_by: PERSON_ID,
      amount: "10,00",
      split_type: "equal",
    });
    expect(res).toEqual({ ok: false, message: ARCHIVED_TRIP_MSG });
  });

  it("lehnt auch den Replay einer Gutschrift ab", async () => {
    const { supabase } = makeSupabase(true);
    mockedAdminClient.mockReturnValue(supabase as never);
    const res = await replayPendingTransaction("credit", {
      trip_id: TRIP_ID,
      date: "2026-06-07",
      description: "Offline",
      amount: "10,00",
      credit_from: PERSON_ID,
      credit_to: OTHER_ID,
    });
    expect(res).toEqual({ ok: false, message: ARCHIVED_TRIP_MSG });
  });
});

describe("inviteMember — archivierter Törn (D3)", () => {
  function inviteFormData(): FormData {
    const fd = new FormData();
    fd.set("trip_id", TRIP_ID);
    fd.set("email", "neu@example.de");
    return fd;
  }

  it("lehnt eine neue Einladung ab", async () => {
    const { supabase } = makeSupabase(true);
    mockedAdminClient.mockReturnValue(supabase as never);
    const res = await inviteMember({ status: "idle" }, inviteFormData());
    expect(res).toEqual({ status: "error", message: ARCHIVED_TRIP_MSG });
  });

  it("lässt die Einladung an einem NICHT archivierten Törn durch den Guard (Positivfall)", async () => {
    const { supabase } = makeSupabase(false, {
      persons_private: { data: null },
      persons: { data: { id: PERSON_ID } },
      trip_members: { data: { id: MEMBER_ID } },
    });
    mockedAdminClient.mockReturnValue(supabase as never);
    const res = await inviteMember({ status: "idle" }, inviteFormData());
    expect(res.status).toBe("ok");
  });
});

describe("removeMember — archivierter Törn (D3)", () => {
  it("lehnt das Entfernen ab", async () => {
    const { supabase } = makeSupabase(true);
    mockedAdminClient.mockReturnValue(supabase as never);
    const res = await removeMember(MEMBER_ID, TRIP_ID);
    expect(res).toEqual({ ok: false, message: ARCHIVED_TRIP_MSG });
  });

  it("erlaubt das Entfernen weiterhin an einem NICHT archivierten Törn (Positivfall)", async () => {
    const { supabase } = makeSupabase(false, {
      trips: { data: { archived: false, skipper_id: OTHER_ID } },
      trip_members: { data: { person_id: PERSON_ID } },
      transactions: { count: 0 },
      transaction_participants: { count: 0 },
    });
    mockedAdminClient.mockReturnValue(supabase as never);
    const res = await removeMember(MEMBER_ID, TRIP_ID);
    expect(res.ok).toBe(true);
  });
});

describe("setSkipperRole — archivierter Törn (D3)", () => {
  it("setzt die Rolle NICHT, wenn der Törn archiviert ist", async () => {
    const { supabase, calls } = makeSupabase(true, {
      trip_members: { data: { person_id: PERSON_ID } },
    });
    mockedAdminClient.mockReturnValue(supabase as never);
    await setSkipperRole(MEMBER_ID, TRIP_ID, true);
    expect(calls.some((c) => c.table === "trip_members" && c.op === "update")).toBe(false);
  });
});

describe("updateMember — archivierter Törn (D3)", () => {
  it("lehnt eine Änderung ab", async () => {
    const { supabase } = makeSupabase(true);
    mockedAdminClient.mockReturnValue(supabase as never);
    const fd = new FormData();
    fd.set("member_id", MEMBER_ID);
    fd.set("trip_id", TRIP_ID);
    fd.set("note", "neu");
    const res = await updateMember({ status: "idle" }, fd);
    expect(res).toEqual({ status: "error", message: ARCHIVED_TRIP_MSG });
  });
});

describe("addCategory — archivierter Törn (D3)", () => {
  function catFormData(): FormData {
    const fd = new FormData();
    fd.set("trip_id", TRIP_ID);
    fd.set("name", "Neue Kategorie");
    return fd;
  }

  it("lehnt das Anlegen ab", async () => {
    const { supabase } = makeSupabase(true);
    mockedAdminClient.mockReturnValue(supabase as never);
    const res = await addCategory({ status: "idle" }, catFormData());
    expect(res).toEqual({ status: "error", message: ARCHIVED_TRIP_MSG });
  });

  it("erlaubt das Anlegen weiterhin an einem NICHT archivierten Törn (Positivfall)", async () => {
    const { supabase } = makeSupabase(false, {
      trip_categories: { data: { id: CATEGORY_ID, name: "Neue Kategorie" } },
    });
    mockedAdminClient.mockReturnValue(supabase as never);
    const res = await addCategory({ status: "idle" }, catFormData());
    expect(res).toEqual({ status: "ok" });
  });
});

describe("removeCategory — archivierter Törn (D3)", () => {
  it("lehnt das Löschen ab", async () => {
    const { supabase, calls } = makeSupabase(true);
    mockedAdminClient.mockReturnValue(supabase as never);
    await removeCategory(CATEGORY_ID, TRIP_ID);
    expect(calls.some((c) => c.table === "trip_categories" && c.op === "delete")).toBe(false);
  });
});

describe("setCategoryIcon — archivierter Törn (D3)", () => {
  it("lehnt die Icon-Änderung ab", async () => {
    const { supabase } = makeSupabase(true);
    mockedAdminClient.mockReturnValue(supabase as never);
    const res = await setCategoryIcon(CATEGORY_ID, "ShoppingCart", TRIP_ID);
    expect(res).toEqual({ ok: false, message: ARCHIVED_TRIP_MSG });
  });

  it("erlaubt die Icon-Änderung weiterhin an einem NICHT archivierten Törn (Positivfall)", async () => {
    const { supabase } = makeSupabase(false);
    mockedAdminClient.mockReturnValue(supabase as never);
    const res = await setCategoryIcon(CATEGORY_ID, "ShoppingCart", TRIP_ID);
    expect(res).toEqual({ ok: true });
  });
});

describe("savePrepaymentPlan — archivierter Törn (D3)", () => {
  function planFormData(): FormData {
    const fd = new FormData();
    fd.set(
      "payload",
      JSON.stringify({
        trip_id: TRIP_ID,
        split_method: "gleichmaessig",
        total_amount: 300,
        cabin_types: [],
        obligations: [],
      }),
    );
    return fd;
  }

  it("lehnt das Speichern ab", async () => {
    const { supabase } = makeSupabase(true);
    mockedAdminClient.mockReturnValue(supabase as never);
    const res = await savePrepaymentPlan({ status: "idle" }, planFormData());
    expect(res).toEqual({ status: "error", message: ARCHIVED_TRIP_MSG });
  });
});

describe("saveTranches — archivierter Törn (D3)", () => {
  function tranchesFormData(): FormData {
    const fd = new FormData();
    fd.set(
      "payload",
      JSON.stringify({
        trip_id: TRIP_ID,
        tranches: [{ due_date: "2026-06-01", label: "Endzahlung", percent: 100, sort_order: 0 }],
      }),
    );
    return fd;
  }

  it("lehnt das Speichern ab", async () => {
    const { supabase } = makeSupabase(true);
    mockedAdminClient.mockReturnValue(supabase as never);
    const res = await saveTranches({ status: "idle" }, tranchesFormData());
    expect(res).toEqual({ status: "error", message: ARCHIVED_TRIP_MSG });
  });

  it("erlaubt das Speichern weiterhin an einem NICHT archivierten Törn (Positivfall)", async () => {
    const { supabase } = makeSupabase(false, {
      prepayment_tranches: { list: [] },
    });
    mockedAdminClient.mockReturnValue(supabase as never);
    const res = await saveTranches({ status: "idle" }, tranchesFormData());
    expect(res).toEqual({ status: "ok" });
  });
});

describe("recordPayment — archivierter Törn (D3)", () => {
  function paymentFormData(): FormData {
    const fd = new FormData();
    fd.set("trip_id", TRIP_ID);
    fd.set("tranche_id", TRANCHE_ID);
    fd.set("person_id", PERSON_ID);
    fd.set("amount", "10,00");
    fd.set("date", "2026-06-07");
    return fd;
  }

  it("lehnt das Erfassen einer Zahlung ab", async () => {
    const { supabase } = makeSupabase(true);
    mockedAdminClient.mockReturnValue(supabase as never);
    const res = await recordPayment({ status: "idle" }, paymentFormData());
    expect(res).toEqual({ status: "error", message: ARCHIVED_TRIP_MSG });
  });
});

describe("submitSelfPayment — archivierter Törn (D3)", () => {
  function selfPaymentFormData(): FormData {
    const fd = new FormData();
    fd.set("trip_id", TRIP_ID);
    fd.set("tranche_id", TRANCHE_ID);
    fd.set("amount", "10,00");
    fd.set("date", "2026-06-07");
    return fd;
  }

  it("lehnt die Selbstmeldung ab", async () => {
    const { supabase } = makeSupabase(true);
    mockedAdminClient.mockReturnValue(supabase as never);
    const res = await submitSelfPayment({ status: "idle" }, selfPaymentFormData());
    expect(res).toEqual({ status: "error", message: ARCHIVED_TRIP_MSG });
  });

  it("erlaubt die Selbstmeldung weiterhin an einem NICHT archivierten Törn (Positivfall)", async () => {
    const { supabase } = makeSupabase(false, {
      trips: { data: { archived: false, skipper_id: OTHER_ID, name: "Testtörn" } },
      prepayment_tranches: { data: { label: "Endzahlung" } },
      transactions: { data: { id: TX_ID } },
    });
    mockedAdminClient.mockReturnValue(supabase as never);
    const res = await submitSelfPayment({ status: "idle" }, selfPaymentFormData());
    expect(res).toEqual({ status: "ok" });
  });
});

describe("confirmSelfPayment — archivierter Törn (D3)", () => {
  function txFormData(): FormData {
    const fd = new FormData();
    fd.set("transaction_id", TX_ID);
    return fd;
  }

  it("lehnt die Bestätigung ab", async () => {
    const { supabase } = makeSupabase(true, {
      transactions: {
        data: { trip_id: TRIP_ID, tranche_id: TRANCHE_ID, credit_from: PERSON_ID, amount: 10, confirmed_at: null, deleted_at: null },
      },
    });
    mockedAdminClient.mockReturnValue(supabase as never);
    const res = await confirmSelfPayment({ status: "idle" }, txFormData());
    expect(res).toEqual({ status: "error", message: ARCHIVED_TRIP_MSG });
  });
});

describe("rejectSelfPayment — archivierter Törn (D3)", () => {
  function txFormData(): FormData {
    const fd = new FormData();
    fd.set("transaction_id", TX_ID);
    return fd;
  }

  it("lehnt das Ablehnen ab", async () => {
    const { supabase } = makeSupabase(true, {
      transactions: {
        data: { trip_id: TRIP_ID, tranche_id: TRANCHE_ID, credit_from: PERSON_ID, amount: 10, confirmed_at: null, deleted_at: null },
      },
    });
    mockedAdminClient.mockReturnValue(supabase as never);
    const res = await rejectSelfPayment({ status: "idle" }, txFormData());
    expect(res).toEqual({ status: "error", message: ARCHIVED_TRIP_MSG });
  });
});

describe("replaceMember — archivierter Törn (D3)", () => {
  function replaceFormData(): FormData {
    const fd = new FormData();
    fd.set("trip_id", TRIP_ID);
    fd.set("old_person_id", PERSON_ID);
    fd.set("new_display_name", "Nachfolger");
    fd.set("new_email", "");
    fd.set("new_person_id", OTHER_ID);
    return fd;
  }

  it("lehnt den Crewwechsel ab", async () => {
    const { supabase, calls } = makeSupabase(true);
    mockedAdminClient.mockReturnValue(supabase as never);
    const res = await replaceMember({ status: "idle" }, replaceFormData());
    expect(res).toEqual({ status: "error", message: ARCHIVED_TRIP_MSG });
    // Alles-oder-nichts: keine Schreiboperation vor dem Archiv-Abbruch.
    expect(calls).toHaveLength(0);
  });
});

describe("setDepositSettled — archivierter Törn (D3, Grill-Review-Fund)", () => {
  it("lehnt das Abhaken der Kaution ab, wenn der Törn archiviert ist", async () => {
    const { supabase, calls } = makeSupabase(true);
    mockedAdminClient.mockReturnValue(supabase as never);
    const res = await setDepositSettled(TRIP_ID, true);
    expect(res).toEqual({ ok: false });
    expect(calls).toHaveLength(0);
  });

  it("erlaubt das Abhaken, wenn der Törn nicht archiviert ist", async () => {
    const { supabase } = makeSupabase(false, {
      trips: { data: { archived: false }, error: null },
    });
    mockedAdminClient.mockReturnValue(supabase as never);
    const res = await setDepositSettled(TRIP_ID, true);
    expect(res).toEqual({ ok: true });
  });
});
