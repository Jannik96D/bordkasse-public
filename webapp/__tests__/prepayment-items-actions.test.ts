// Reise-Posten — Server-Actions (lib/actions/prepayment-items.ts, PR4a).
//
// Läuft gegen den filternden In-Memory-Fake (__tests__/helpers/fake-supabase):
// geprüft wird, was am Ende WIRKLICH in den Tabellen steht. Abgedeckt:
// Rollen, Archiv-Guard, Cross-Trip/IDOR (fremde Posten-, Kategorie-,
// Personen-IDs), Löschschutz, Idempotenz, Teilfehler-Rollback, Empfänger-
// Rechte und die Bilanz-Invariante (per_person = Soll → Gesamtbilanz je
// Person 0, auch bei ungleichem Soll und einem Mitglied ohne Soll).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/authz", () => ({
  requireMember: vi.fn(),
  requireSkipperOrAdmin: vi.fn(),
  requireSkipperAdminOrItemPayee: vi.fn(),
}));
vi.mock("@/lib/auth/get-current-person", () => ({ getCurrentPerson: vi.fn() }));

import {
  saveItem,
  deleteItem,
  recordItemPayment,
  submitItemSelfPayment,
  confirmItemSelfPayment,
  rejectItemSelfPayment,
  recordItemProviderPayment,
} from "@/lib/actions/prepayment-items";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { requireMember, requireSkipperOrAdmin, requireSkipperAdminOrItemPayee } from "@/lib/auth/authz";
import { createAdminClient } from "@/lib/supabase/admin";
import { createFakeSupabase, type Row } from "./helpers/fake-supabase";

const mockedPerson = vi.mocked(getCurrentPerson);
const mockedMember = vi.mocked(requireMember);
const mockedSkipper = vi.mocked(requireSkipperOrAdmin);
const mockedPayee = vi.mocked(requireSkipperAdminOrItemPayee);
const mockedAdmin = vi.mocked(createAdminClient);

const TRIP = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_TRIP = "aaaaaaaa-0000-4000-8000-000000000099";
const SKIPPER = "aaaaaaaa-0000-4000-8000-000000000002"; // auch Default-Empfänger
const ANNA = "aaaaaaaa-0000-4000-8000-000000000003";
const BEN = "aaaaaaaa-0000-4000-8000-000000000004";
const CLARA = "aaaaaaaa-0000-4000-8000-000000000005"; // reist selbst an, kein Soll
const STRANGER = "aaaaaaaa-0000-4000-8000-000000000006"; // Crew eines anderen Törns
const ITEM = "aaaaaaaa-0000-4000-8000-0000000000d1";
const FOREIGN_ITEM = "aaaaaaaa-0000-4000-8000-0000000000d9";
const CAT = "aaaaaaaa-0000-4000-8000-0000000000c1";
const FOREIGN_CAT = "aaaaaaaa-0000-4000-8000-0000000000c9";
const KEY1 = "aaaaaaaa-0000-4000-8000-0000000000e1";
const KEY2 = "aaaaaaaa-0000-4000-8000-0000000000e2";

function baseTables(extra: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  return {
    trips: [
      { id: TRIP, archived: false, skipper_id: SKIPPER, start_date: "2027-05-01", end_date: "2027-05-10" },
      { id: OTHER_TRIP, archived: false, skipper_id: STRANGER, start_date: "2027-06-01", end_date: "2027-06-10" },
    ],
    trip_members: [
      { trip_id: TRIP, person_id: SKIPPER, on_board_from: null, on_board_to: null },
      { trip_id: TRIP, person_id: ANNA, on_board_from: null, on_board_to: null },
      { trip_id: TRIP, person_id: BEN, on_board_from: null, on_board_to: null },
      { trip_id: TRIP, person_id: CLARA, on_board_from: null, on_board_to: null },
      { trip_id: OTHER_TRIP, person_id: STRANGER, on_board_from: null, on_board_to: null },
    ],
    trip_categories: [
      { id: CAT, trip_id: TRIP, name: "An-/Abreise", icon: "Plane" },
      { id: FOREIGN_CAT, trip_id: OTHER_TRIP, name: "An-/Abreise", icon: "Plane" },
    ],
    prepayment_items: [
      {
        id: FOREIGN_ITEM, trip_id: OTHER_TRIP, category_id: null, label: "Fremd", total_amount: 50,
        due_date: null, payee_person_id: STRANGER, split_type: "gleichmaessig", sort_order: 0,
      },
    ],
    prepayment_item_obligations: [],
    transactions: [],
    transaction_participants: [],
    audit_log: [],
    ...extra,
  } as Record<string, Row[]>;
}

/** Posten ITEM: 300 € Flüge, Empfänger SKIPPER, ungleiches Soll, Clara ohne Soll. */
function withItem(extra: Partial<Record<string, Row[]>> = {}) {
  return baseTables({
    prepayment_items: [
      ...baseTables().prepayment_items,
      {
        id: ITEM, trip_id: TRIP, category_id: CAT, label: "Flüge", total_amount: 300,
        due_date: "2027-03-01", payee_person_id: SKIPPER, split_type: "individuell", sort_order: 0,
      },
    ],
    prepayment_item_obligations: [
      { item_id: ITEM, trip_id: TRIP, person_id: SKIPPER, amount: 50 },
      { item_id: ITEM, trip_id: TRIP, person_id: ANNA, amount: 100 },
      { item_id: ITEM, trip_id: TRIP, person_id: BEN, amount: 150 },
      { item_id: ITEM, trip_id: TRIP, person_id: CLARA, amount: 0 },
    ],
    ...extra,
  });
}

function payloadFd(payload: Record<string, unknown>): FormData {
  const f = new FormData();
  f.set("payload", JSON.stringify(payload));
  return f;
}
function fd(values: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

let fake: ReturnType<typeof createFakeSupabase>;
function useFake(tables: Record<string, Row[]>) {
  fake = createFakeSupabase(tables);
  mockedAdmin.mockReturnValue(fake.client as never);
  return fake;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPerson.mockResolvedValue({ id: SKIPPER, display_name: "Skipper" } as never);
  mockedSkipper.mockResolvedValue({ ok: true, personId: SKIPPER });
  mockedMember.mockResolvedValue({ ok: true, personId: ANNA });
  mockedPayee.mockResolvedValue({ ok: true, personId: SKIPPER, tripId: TRIP, payeePersonId: SKIPPER });
});

/** Gesamtbilanz je Person wie v_balances (paid − share + credit_given − credit_received). */
function totalBalance(tables: Record<string, Row[]>, person: string): number {
  const live = (tables.transactions ?? []).filter((t) => !t.deleted_at && (t.type !== "credit" || t.confirmed_at));
  let b = 0;
  for (const t of live) {
    if (t.type === "expense") {
      if (t.paid_by === person) b += Number(t.amount);
      const parts = (tables.transaction_participants ?? []).filter((p) => p.transaction_id === t.id && p.person_id === person);
      for (const p of parts) b -= Number(p.amount);
    } else {
      if (t.credit_from === person) b += Number(t.amount);
      if (t.credit_to === person) b -= Number(t.amount);
    }
  }
  return Math.round(b * 100) / 100;
}

// ─────────────────────────────────────────────────────────────────────────
describe("saveItem — anlegen", () => {
  it("legt einen gleichmäßigen Posten an: Σ Soll = Summe exakt, Empfänger = Skipper als Default", async () => {
    useFake(baseTables());
    const res = await saveItem({ status: "idle" }, payloadFd({
      trip_id: TRIP, id: ITEM, category_id: CAT, label: "Bahn", total_amount: "100,00", split_type: "gleichmaessig",
    }));
    expect(res).toEqual({ status: "ok", itemId: ITEM });
    const item = fake.rows("prepayment_items").find((r) => r.id === ITEM)!;
    expect(item.payee_person_id).toBe(SKIPPER);
    expect(item.trip_id).toBe(TRIP);
    const obl = fake.rows("prepayment_item_obligations").filter((r) => r.item_id === ITEM);
    expect(obl).toHaveLength(4);
    expect(Math.round(obl.reduce((s, o) => s + Number(o.amount), 0) * 100)).toBe(10000);
    expect(obl.every((o) => o.trip_id === TRIP)).toBe(true);
  });

  it("weist einen Empfänger ab, der nicht Crew dieses Törns ist", async () => {
    useFake(baseTables());
    const res = await saveItem({ status: "idle" }, payloadFd({
      trip_id: TRIP, id: ITEM, label: "Bahn", total_amount: "100", split_type: "gleichmaessig", payee_person_id: STRANGER,
    }));
    expect(res.status).toBe("error");
    expect(fake.rows("prepayment_items").some((r) => r.id === ITEM)).toBe(false);
  });

  it("weist eine Kategorie eines fremden Törns ab", async () => {
    useFake(baseTables());
    const res = await saveItem({ status: "idle" }, payloadFd({
      trip_id: TRIP, id: ITEM, category_id: FOREIGN_CAT, label: "Bahn", total_amount: "100", split_type: "gleichmaessig",
    }));
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toContain("Kategorie");
    expect(fake.rows("prepayment_items").some((r) => r.id === ITEM)).toBe(false);
  });

  it("weist eine Posten-ID eines FREMDEN Törns ab und lässt den fremden Posten unangetastet (Klasse F1)", async () => {
    useFake(baseTables());
    const res = await saveItem({ status: "idle" }, payloadFd({
      // Empfänger explizit aus DIESEM Törn — sonst fiele der Versuch schon am
      // Empfänger-Check und der ID-Guard bliebe ungetestet.
      trip_id: TRIP, id: FOREIGN_ITEM, label: "Gekapert", total_amount: "999", split_type: "gleichmaessig",
      payee_person_id: SKIPPER,
    }));
    expect(res.status).toBe("error");
    const foreign = fake.rows("prepayment_items").find((r) => r.id === FOREIGN_ITEM)!;
    expect(foreign.label).toBe("Fremd");
    expect(foreign.trip_id).toBe(OTHER_TRIP);
    expect(fake.rows("prepayment_item_obligations")).toHaveLength(0);
  });

  it("individuell: Σ Einzelbeträge ≠ Summe wird abgewiesen", async () => {
    useFake(baseTables());
    const res = await saveItem({ status: "idle" }, payloadFd({
      trip_id: TRIP, id: ITEM, label: "Flüge", total_amount: "300", split_type: "individuell",
      obligations: [{ person_id: ANNA, amount: "100" }, { person_id: BEN, amount: "150" }],
    }));
    expect(res.status).toBe("error");
    expect(fake.rows("prepayment_items").some((r) => r.id === ITEM)).toBe(false);
  });

  it("individuell: eine Person aus einem fremden Törn wird abgewiesen", async () => {
    useFake(baseTables());
    const res = await saveItem({ status: "idle" }, payloadFd({
      trip_id: TRIP, id: ITEM, label: "Flüge", total_amount: "300", split_type: "individuell",
      obligations: [{ person_id: ANNA, amount: "150" }, { person_id: STRANGER, amount: "150" }],
    }));
    expect(res.status).toBe("error");
    expect(fake.rows("prepayment_items").some((r) => r.id === ITEM)).toBe(false);
  });

  it("archivierter Törn → kein Schreiben", async () => {
    const tables = baseTables();
    tables.trips[0].archived = true;
    useFake(tables);
    const res = await saveItem({ status: "idle" }, payloadFd({
      trip_id: TRIP, id: ITEM, label: "Bahn", total_amount: "100", split_type: "gleichmaessig",
    }));
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toContain("archiviert");
    expect(fake.rows("prepayment_items").some((r) => r.id === ITEM)).toBe(false);
  });

  it("ohne Skipper-/Admin-Recht → kein Schreiben", async () => {
    useFake(baseTables());
    mockedSkipper.mockResolvedValue({ ok: false, message: "Nur Skipper dürfen das ändern." });
    const res = await saveItem({ status: "idle" }, payloadFd({
      trip_id: TRIP, id: ITEM, label: "Bahn", total_amount: "100", split_type: "gleichmaessig",
    }));
    expect(res.status).toBe("error");
    expect(fake.writes.filter((w) => w.table !== "audit_log")).toHaveLength(0);
  });

  it("Rollback: scheitert das Soll, verschwindet der eben angelegte Posten wieder", async () => {
    useFake(baseTables());
    fake.failOn({ table: "prepayment_item_obligations", action: "insert" });
    const res = await saveItem({ status: "idle" }, payloadFd({
      trip_id: TRIP, id: ITEM, label: "Bahn", total_amount: "100", split_type: "gleichmaessig",
    }));
    expect(res.status).toBe("error");
    expect(fake.rows("prepayment_items").some((r) => r.id === ITEM)).toBe(false);
  });

  it("Audit-Log ohne Freitext-Bezeichnung", async () => {
    useFake(baseTables());
    await saveItem({ status: "idle" }, payloadFd({
      trip_id: TRIP, id: ITEM, label: "Flug für Anna Müller", total_amount: "100", split_type: "gleichmaessig",
    }));
    const audit = fake.rows("audit_log").find((a) => a.table_name === "prepayment_items")!;
    expect(JSON.stringify(audit.payload)).not.toContain("Anna");
  });
});

describe("saveItem — ändern", () => {
  const indiv = (amounts: [string, string][]) => ({
    trip_id: TRIP, id: ITEM, category_id: CAT, label: "Flüge", total_amount: "300", split_type: "individuell",
    obligations: amounts.map(([person_id, amount]) => ({ person_id, amount })),
  });
  const providerTx = { id: "tx-prov", trip_id: TRIP, type: "expense", item_id: ITEM, amount: 300, paid_by: SKIPPER, deleted_at: null, confirmed_at: "x" };

  it("verteilt das Soll neu (Delete + Insert)", async () => {
    useFake(withItem());
    const res = await saveItem({ status: "idle" }, payloadFd(indiv([[ANNA, "150"], [BEN, "150"]])));
    expect(res.status).toBe("ok");
    const obl = fake.rows("prepayment_item_obligations").filter((r) => r.item_id === ITEM);
    expect(obl.map((o) => `${o.person_id}:${o.amount}`).sort()).toEqual([`${ANNA}:150`, `${BEN}:150`].sort());
  });

  it("sperrt eine Soll-Änderung, sobald eine Anbieter-Zahlung gebucht ist", async () => {
    useFake(withItem({ transactions: [providerTx] }));
    const res = await saveItem({ status: "idle" }, payloadFd(indiv([[ANNA, "150"], [BEN, "150"]])));
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toContain("Anbieter");
    const anna = fake.rows("prepayment_item_obligations").find((r) => r.person_id === ANNA)!;
    expect(anna.amount).toBe(100);
  });

  it("erlaubt trotz Anbieter-Zahlung eine reine Umbenennung (Soll unverändert)", async () => {
    useFake(withItem({ transactions: [providerTx] }));
    const res = await saveItem({ status: "idle" }, payloadFd({
      ...indiv([[SKIPPER, "50"], [ANNA, "100"], [BEN, "150"], [CLARA, "0"]]), label: "Flüge Hin+Rück",
    }));
    expect(res.status).toBe("ok");
    expect(fake.rows("prepayment_items").find((r) => r.id === ITEM)!.label).toBe("Flüge Hin+Rück");
  });

  it("Empfängerwechsel läuft über move_item_payee (atomar in SQL)", async () => {
    useFake(withItem());
    const res = await saveItem({ status: "idle" }, payloadFd({
      ...indiv([[SKIPPER, "50"], [ANNA, "100"], [BEN, "150"]]), payee_person_id: ANNA,
    }));
    expect(res.status).toBe("ok");
    expect(fake.rpcCalls).toContainEqual({ name: "move_item_payee", args: { p_item_id: ITEM, p_new_payee: ANNA } });
    // Der Empfänger wird NICHT per normalem UPDATE gesetzt (der Trigger würde
    // bei hängenden Gutschriften blocken) — nur die Funktion darf das.
    expect(fake.writes.some((w) => w.table === "prepayment_items" && w.action === "update" &&
      (w.payload as Row).payee_person_id !== undefined)).toBe(false);
    // Settlement-Marker: credit_to wandert → Bilanz ändert sich.
    expect(fake.rpcCalls.some((c) => c.name === "mark_post_settlement_change")).toBe(true);
  });

  it("Empfängerwechsel scheitert → Posten und Soll werden zurückgerollt", async () => {
    useFake(withItem());
    fake.onRpc("move_item_payee", () => ({ error: { message: "prepayment_item_payee_invalid" } }));
    const res = await saveItem({ status: "idle" }, payloadFd({
      ...indiv([[ANNA, "150"], [BEN, "150"]]), label: "Neu", payee_person_id: ANNA,
    }));
    expect(res.status).toBe("error");
    expect(fake.rows("prepayment_items").find((r) => r.id === ITEM)!.label).toBe("Flüge");
    const obl = fake.rows("prepayment_item_obligations").filter((r) => r.item_id === ITEM);
    expect(obl).toHaveLength(4);
    expect(obl.find((o) => o.person_id === BEN)!.amount).toBe(150);
    expect(obl.find((o) => o.person_id === ANNA)!.amount).toBe(100);
  });

  it("sperrt den Empfängerwechsel, sobald der bisherige Empfänger an den Anbieter gezahlt hat", async () => {
    useFake(withItem({ transactions: [providerTx] }));
    const res = await saveItem({ status: "idle" }, payloadFd({
      ...indiv([[SKIPPER, "50"], [ANNA, "100"], [BEN, "150"], [CLARA, "0"]]), payee_person_id: ANNA,
    }));
    expect(res.status).toBe("error");
    expect(fake.rpcCalls.some((c) => c.name === "move_item_payee")).toBe(false);
  });

  it("nach einer Anbieter-Zahlung: Umbenennen klappt auch nach einer Crew-Änderung, das Soll bleibt unangetastet", async () => {
    // gleichmäßiger Posten, gespeichertes Soll 100/100/100; danach kommt Clara
    // dazu — ein Neuberechnen ergäbe 75/75/75/75 und sperrte sonst jede Änderung.
    const t = withItem({ transactions: [providerTx] });
    t.prepayment_items = t.prepayment_items.map((i) => (i.id === ITEM ? { ...i, split_type: "gleichmaessig" } : i));
    t.prepayment_item_obligations = [
      { item_id: ITEM, trip_id: TRIP, person_id: SKIPPER, amount: 100 },
      { item_id: ITEM, trip_id: TRIP, person_id: ANNA, amount: 100 },
      { item_id: ITEM, trip_id: TRIP, person_id: BEN, amount: 100 },
    ];
    useFake(t);
    const res = await saveItem({ status: "idle" }, payloadFd({
      trip_id: TRIP, id: ITEM, category_id: CAT, label: "Flüge (gebucht)", total_amount: "300", split_type: "gleichmaessig",
    }));
    expect(res.status).toBe("ok");
    expect(fake.rows("prepayment_items").find((r) => r.id === ITEM)!.label).toBe("Flüge (gebucht)");
    const obl = fake.rows("prepayment_item_obligations").filter((r) => r.item_id === ITEM);
    expect(obl.map((o) => o.amount)).toEqual([100, 100, 100]);
    expect(fake.writes.some((w) => w.table === "prepayment_item_obligations")).toBe(false);
  });

  it("Race: wird WÄHREND des Neuverteilens eine Anbieter-Zahlung gebucht, wird zurückgerollt", async () => {
    useFake(withItem());
    // 3. from("transactions") = Nachkontrolle nach dem Soll-Insert.
    fake.onFrom("transactions", 2, () => fake.rows("transactions").push({ ...providerTx }));
    const res = await saveItem({ status: "idle" }, payloadFd(indiv([[ANNA, "150"], [BEN, "150"]])));
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toContain("Während des Speicherns");
    expect(fake.rows("prepayment_item_obligations").find((o) => o.person_id === ANNA)!.amount).toBe(100);
  });

  it("Race: hat die parallele Anbieter-Zahlung schon nach dem NEUEN Soll verteilt, bleibt das neue Soll", async () => {
    useFake(withItem());
    fake.onFrom("transactions", 2, () => {
      fake.rows("transactions").push({ ...providerTx });
      fake.rows("transaction_participants").push(
        { transaction_id: "tx-prov", person_id: ANNA, amount: 150 },
        { transaction_id: "tx-prov", person_id: BEN, amount: 150 },
      );
    });
    const res = await saveItem({ status: "idle" }, payloadFd(indiv([[ANNA, "150"], [BEN, "150"]])));
    expect(res.status).toBe("ok");
    expect(fake.rows("prepayment_item_obligations").find((o) => o.person_id === ANNA)!.amount).toBe(150);
  });

  it("scheitert auch das Zurücksetzen, sagt die Meldung das", async () => {
    useFake(withItem());
    fake.failOn({ table: "prepayment_item_obligations", action: "insert" });
    fake.failOn({ table: "prepayment_item_obligations", action: "insert", nth: 2 });
    const res = await saveItem({ status: "idle" }, payloadFd({ ...indiv([[ANNA, "150"], [BEN, "150"]]), label: "Neu" }));
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toContain("Zurücksetzen");
  });

  it("Rollback: scheitert das neue Soll, kommt das alte zurück", async () => {
    useFake(withItem());
    fake.failOn({ table: "prepayment_item_obligations", action: "insert" });
    const res = await saveItem({ status: "idle" }, payloadFd({ ...indiv([[ANNA, "150"], [BEN, "150"]]), label: "Neu" }));
    expect(res.status).toBe("error");
    const obl = fake.rows("prepayment_item_obligations").filter((r) => r.item_id === ITEM);
    expect(obl).toHaveLength(4);
    expect(fake.rows("prepayment_items").find((r) => r.id === ITEM)!.label).toBe("Flüge");
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("deleteItem — Löschschutz", () => {
  const del = (item = ITEM) => deleteItem({ status: "idle" }, fd({ trip_id: TRIP, item_id: item }));

  it("blockt bei bestätigter Zahlung", async () => {
    useFake(withItem({ transactions: [{ id: "c1", trip_id: TRIP, type: "credit", item_id: ITEM, amount: 100, confirmed_at: "x", deleted_at: null }] }));
    const res = await del();
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toContain("bestätigte");
    expect(fake.rows("prepayment_items").some((r) => r.id === ITEM)).toBe(true);
  });

  it("blockt bei offener Selbstmeldung", async () => {
    useFake(withItem({ transactions: [{ id: "c1", trip_id: TRIP, type: "credit", item_id: ITEM, amount: 100, confirmed_at: null, deleted_at: null }] }));
    const res = await del();
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toContain("unbestätigte");
    expect(fake.rows("prepayment_items").some((r) => r.id === ITEM)).toBe(true);
  });

  it("löscht, wenn nur soft-gelöschte Zeilen daran hängen", async () => {
    useFake(withItem({ transactions: [{ id: "c1", trip_id: TRIP, type: "credit", item_id: ITEM, amount: 100, confirmed_at: "x", deleted_at: "y" }] }));
    const res = await del();
    expect(res.status).toBe("ok");
    expect(fake.rows("prepayment_items").some((r) => r.id === ITEM)).toBe(false);
  });

  it("ein Posten eines fremden Törns wird nicht gelöscht (IDOR)", async () => {
    useFake(withItem());
    const res = await del(FOREIGN_ITEM);
    expect(res.status).toBe("error");
    expect(fake.rows("prepayment_items").some((r) => r.id === FOREIGN_ITEM)).toBe(true);
  });

  it("übersetzt den Trigger-Fehler bei einem Race in eine verständliche Meldung", async () => {
    useFake(withItem());
    fake.failOn({ table: "prepayment_items", action: "delete", error: { code: "P0001", message: "prepayment_item_has_payments" } });
    const res = await del();
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.message).toContain("bestätigte Zahlungen");
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("recordItemPayment — Crew → Empfänger", () => {
  const rec = (extra: Record<string, string> = {}) =>
    recordItemPayment({ status: "idle" }, fd({
      trip_id: TRIP, item_id: ITEM, person_id: ANNA, amount: "100,00", date: "2027-02-01", idempotency_key: KEY1, ...extra,
    }));

  it("bucht eine bestätigte Gutschrift an den Empfänger AUS DEM POSTEN", async () => {
    useFake(withItem());
    const res = await rec({ credit_to: BEN }); // untergeschobener Empfänger wird ignoriert
    expect(res.status).toBe("ok");
    const tx = fake.rows("transactions");
    expect(tx).toHaveLength(1);
    expect(tx[0]).toMatchObject({ type: "credit", credit_from: ANNA, credit_to: SKIPPER, item_id: ITEM, trip_id: TRIP, amount: 100 });
    expect(tx[0].confirmed_at).toBeTruthy();
    expect(fake.rpcCalls.some((c) => c.name === "mark_post_settlement_change")).toBe(true);
  });

  it("Retry mit gleichem idempotency_key bucht nicht doppelt", async () => {
    useFake(withItem());
    expect((await rec()).status).toBe("ok");
    const second = await rec();
    expect(second).toMatchObject({ status: "ok", duplicate: true });
    expect(fake.rows("transactions")).toHaveLength(1);
  });

  it("Posten eines fremden Törns (Auth liefert anderen Törn) → kein Insert", async () => {
    useFake(withItem());
    mockedPayee.mockResolvedValue({ ok: true, personId: SKIPPER, tripId: OTHER_TRIP, payeePersonId: STRANGER });
    const res = await rec({ item_id: FOREIGN_ITEM });
    expect(res.status).toBe("error");
    expect(fake.rows("transactions")).toHaveLength(0);
  });

  it("ein idempotency_key, der zu einer ANDEREN Buchung gehört, ist kein „Duplikat“", async () => {
    useFake(withItem({ transactions: [{ id: "other", trip_id: TRIP, type: "expense", item_id: null, idempotency_key: KEY1, amount: 5, deleted_at: null }] }));
    const res = await rec();
    expect(res.status).toBe("error");
    expect(fake.rows("transactions")).toHaveLength(1);
  });

  it("Audit-Log zeigt auf die neue Buchung, nicht auf den Posten", async () => {
    useFake(withItem());
    await rec();
    const txId = fake.rows("transactions")[0].id;
    const audit = fake.rows("audit_log").find((a) => (a.payload as Row)?.kind === "item-payment")!;
    expect(audit.record_id).toBe(txId);
  });

  it("Zahler aus einem fremden Törn → kein Insert", async () => {
    useFake(withItem());
    const res = await rec({ person_id: STRANGER });
    expect(res.status).toBe("error");
    expect(fake.rows("transactions")).toHaveLength(0);
  });

  it("ohne Empfänger-/Skipper-Recht → kein Insert", async () => {
    useFake(withItem());
    mockedPayee.mockResolvedValue({ ok: false, message: "Nur Skipper, Admin oder die Person, die diesen Posten empfängt, dürfen das." });
    expect((await rec()).status).toBe("error");
    expect(fake.rows("transactions")).toHaveLength(0);
  });

  it("archivierter Törn → kein Insert", async () => {
    const tables = withItem();
    tables.trips[0].archived = true;
    useFake(tables);
    expect((await rec()).status).toBe("error");
    expect(fake.rows("transactions")).toHaveLength(0);
  });

  it("Audit-Log ohne Notiz-Freitext", async () => {
    useFake(withItem());
    await rec({ note: "von Anna Müller per PayPal" });
    const audit = fake.rows("audit_log").find((a) => (a.payload as Row)?.kind === "item-payment")!;
    expect(JSON.stringify(audit.payload)).not.toContain("Müller");
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("Selbstmeldung → Bestätigung / Ablehnung", () => {
  it("submit: pending, credit_from = meldende Person (nie aus dem Formular), credit_to = Empfänger", async () => {
    useFake(withItem());
    const res = await submitItemSelfPayment({ status: "idle" }, fd({
      trip_id: TRIP, item_id: ITEM, amount: "100", date: "2027-02-01", person_id: BEN, credit_from: BEN,
    }));
    expect(res.status).toBe("ok");
    const tx = fake.rows("transactions")[0];
    expect(tx).toMatchObject({ credit_from: ANNA, credit_to: SKIPPER, item_id: ITEM, confirmed_at: null });
    // Pending ändert keine Bilanz → kein Settlement-Marker.
    expect(fake.rpcCalls.some((c) => c.name === "mark_post_settlement_change")).toBe(false);
  });

  it("submit: Nicht-Mitglied → kein Insert", async () => {
    useFake(withItem());
    mockedMember.mockResolvedValue({ ok: false, message: "Du bist nicht Mitglied dieses Törns." });
    const res = await submitItemSelfPayment({ status: "idle" }, fd({ trip_id: TRIP, item_id: ITEM, amount: "100", date: "2027-02-01" }));
    expect(res.status).toBe("error");
    expect(fake.rows("transactions")).toHaveLength(0);
  });

  it("submit: Posten eines fremden Törns → kein Insert", async () => {
    useFake(withItem());
    const res = await submitItemSelfPayment({ status: "idle" }, fd({ trip_id: TRIP, item_id: FOREIGN_ITEM, amount: "100", date: "2027-02-01" }));
    expect(res.status).toBe("error");
    expect(fake.rows("transactions")).toHaveLength(0);
  });

  const pending = { trip_id: TRIP, type: "credit", item_id: ITEM, credit_from: ANNA, credit_to: SKIPPER, amount: 100, confirmed_at: null, deleted_at: null };

  it("confirm: bestätigt die offene Meldung", async () => {
    const id = "aaaaaaaa-0000-4000-8000-0000000000f1";
    useFake(withItem({ transactions: [{ ...pending, id }] }));
    const res = await confirmItemSelfPayment({ status: "idle" }, fd({ transaction_id: id }));
    expect(res.status).toBe("ok");
    expect(fake.rows("transactions")[0].confirmed_at).toBeTruthy();
    expect(mockedPayee).toHaveBeenCalledWith(ITEM);
    expect(fake.rpcCalls.some((c) => c.name === "mark_post_settlement_change")).toBe(true);
  });

  it("confirm: ohne Empfänger-Recht am Posten der Buchung → unverändert", async () => {
    const id = "aaaaaaaa-0000-4000-8000-0000000000f1";
    useFake(withItem({ transactions: [{ ...pending, id }] }));
    mockedPayee.mockResolvedValue({ ok: false, message: "nope" });
    expect((await confirmItemSelfPayment({ status: "idle" }, fd({ transaction_id: id }))).status).toBe("error");
    expect(fake.rows("transactions")[0].confirmed_at).toBeNull();
  });

  it("confirm: Rolle für einen ANDEREN Törn als die Buchung → unverändert (IDOR)", async () => {
    const id = "aaaaaaaa-0000-4000-8000-0000000000f1";
    useFake(withItem({ transactions: [{ ...pending, id }] }));
    mockedPayee.mockResolvedValue({ ok: true, personId: STRANGER, tripId: OTHER_TRIP, payeePersonId: STRANGER });
    expect((await confirmItemSelfPayment({ status: "idle" }, fd({ transaction_id: id }))).status).toBe("error");
    expect(fake.rows("transactions")[0].confirmed_at).toBeNull();
  });

  it("confirm: eine Tranchen-Gutschrift ist keine Posten-Zahlung", async () => {
    const id = "aaaaaaaa-0000-4000-8000-0000000000f1";
    useFake(withItem({ transactions: [{ ...pending, id, item_id: null, tranche_id: "t1" }] }));
    expect((await confirmItemSelfPayment({ status: "idle" }, fd({ transaction_id: id }))).status).toBe("error");
    expect(fake.rows("transactions")[0].confirmed_at).toBeNull();
  });

  it("confirm: archivierter Törn → unverändert", async () => {
    const id = "aaaaaaaa-0000-4000-8000-0000000000f1";
    const tables = withItem({ transactions: [{ ...pending, id }] });
    tables.trips[0].archived = true;
    useFake(tables);
    expect((await confirmItemSelfPayment({ status: "idle" }, fd({ transaction_id: id }))).status).toBe("error");
    expect(fake.rows("transactions")[0].confirmed_at).toBeNull();
  });

  it("reject: soft-löscht die offene Meldung, ohne Settlement-Marker", async () => {
    const id = "aaaaaaaa-0000-4000-8000-0000000000f1";
    useFake(withItem({ transactions: [{ ...pending, id }] }));
    const res = await rejectItemSelfPayment({ status: "idle" }, fd({ transaction_id: id }));
    expect(res.status).toBe("ok");
    expect(fake.rows("transactions")[0].deleted_at).toBeTruthy();
    expect(fake.rpcCalls.some((c) => c.name === "mark_post_settlement_change")).toBe(false);
  });

  it("reject: eine bereits bestätigte Zahlung kann nicht abgelehnt werden", async () => {
    const id = "aaaaaaaa-0000-4000-8000-0000000000f1";
    useFake(withItem({ transactions: [{ ...pending, id, confirmed_at: "x" }] }));
    const res = await rejectItemSelfPayment({ status: "idle" }, fd({ transaction_id: id }));
    expect(res.status).toBe("error");
    expect(fake.rows("transactions")[0].deleted_at).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("recordItemProviderPayment — Empfänger → Anbieter", () => {
  const pay = (amount: string, key = KEY1, extra: Record<string, string> = {}) =>
    recordItemProviderPayment({ status: "idle" }, fd({
      trip_id: TRIP, item_id: ITEM, amount, date: "2027-02-01", idempotency_key: key, ...extra,
    }));

  it("schreibt per_person mit den Soll-Beträgen, paid_by = Empfänger, Clara (kein Soll) ohne Anteil", async () => {
    useFake(withItem());
    // Handelnde Person ≠ Empfänger (z. B. Admin bucht für den Empfänger):
    // paid_by muss trotzdem der Empfänger sein.
    mockedPerson.mockResolvedValue({ id: ANNA, display_name: "Anna" } as never);
    const res = await pay("300,00", KEY1, { paid_by: BEN });
    expect(res.status).toBe("ok");
    const tx = fake.rows("transactions")[0];
    expect(tx).toMatchObject({ type: "expense", split_type: "per_person", paid_by: SKIPPER, item_id: ITEM, category_id: CAT, amount: 300 });
    const parts = fake.rows("transaction_participants").filter((p) => p.transaction_id === tx.id);
    expect(parts.map((p) => `${p.person_id}:${p.amount}`).sort()).toEqual(
      [`${SKIPPER}:50`, `${ANNA}:100`, `${BEN}:150`].sort(),
    );
    expect(parts.some((p) => p.person_id === CLARA)).toBe(false);
  });

  it("Gesamtbilanz je Person ist 0, sobald alle ihr (ungleiches) Soll gezahlt haben", async () => {
    useFake(withItem());
    await pay("300");
    await recordItemPayment({ status: "idle" }, fd({ trip_id: TRIP, item_id: ITEM, person_id: SKIPPER, amount: "50", date: "2027-02-02", idempotency_key: KEY2 }));
    await recordItemPayment({ status: "idle" }, fd({ trip_id: TRIP, item_id: ITEM, person_id: ANNA, amount: "100", date: "2027-02-02", idempotency_key: "aaaaaaaa-0000-4000-8000-0000000000e3" }));
    await recordItemPayment({ status: "idle" }, fd({ trip_id: TRIP, item_id: ITEM, person_id: BEN, amount: "150", date: "2027-02-02", idempotency_key: "aaaaaaaa-0000-4000-8000-0000000000e4" }));
    for (const p of [SKIPPER, ANNA, BEN, CLARA]) expect(totalBalance(fake.tables, p)).toBe(0);
  });

  it("Teilzahlungen: kumulative Verteilung, am Ende trägt jede Person exakt ihr Soll", async () => {
    useFake(withItem());
    expect((await pay("100,01", KEY1)).status).toBe("ok");
    expect((await pay("199,99", KEY2)).status).toBe("ok");
    const byPerson = new Map<string, number>();
    for (const p of fake.rows("transaction_participants")) {
      byPerson.set(p.person_id as string, Math.round(((byPerson.get(p.person_id as string) ?? 0) + Number(p.amount)) * 100) / 100);
    }
    expect(byPerson.get(SKIPPER)).toBe(50);
    expect(byPerson.get(ANNA)).toBe(100);
    expect(byPerson.get(BEN)).toBe(150);
    // je Ausgabe: Σ Anteile = Betrag
    for (const tx of fake.rows("transactions")) {
      const sum = fake.rows("transaction_participants").filter((p) => p.transaction_id === tx.id).reduce((s, p) => s + Number(p.amount), 0);
      expect(Math.round(sum * 100)).toBe(Math.round(Number(tx.amount) * 100));
    }
  });

  it("Teilzahlungen bei gleichem Soll: die Rundungs-Cents wandern nicht jedes Mal zur selben Person", async () => {
    useFake(withItem({
      prepayment_item_obligations: [
        { item_id: ITEM, trip_id: TRIP, person_id: SKIPPER, amount: 100 },
        { item_id: ITEM, trip_id: TRIP, person_id: ANNA, amount: 100 },
        { item_id: ITEM, trip_id: TRIP, person_id: BEN, amount: 100 },
      ],
    }));
    for (const key of [KEY1, KEY2, "aaaaaaaa-0000-4000-8000-0000000000e3"]) {
      expect((await pay("100", key)).status).toBe("ok");
    }
    const byPerson = new Map<string, number>();
    for (const p of fake.rows("transaction_participants")) {
      byPerson.set(p.person_id as string, Math.round(((byPerson.get(p.person_id as string) ?? 0) + Number(p.amount)) * 100) / 100);
    }
    // Ohne kumulative Verteilung: 100,02 / 99,99 / 99,99.
    expect([...byPerson.values()]).toEqual([100, 100, 100]);
  });

  it("über die Posten-Summe hinaus → abgewiesen", async () => {
    useFake(withItem());
    await pay("250", KEY1);
    const res = await pay("60", KEY2);
    expect(res.status).toBe("error");
    expect(fake.rows("transactions")).toHaveLength(1);
  });

  it("Race: zwei parallele Anbieter-Zahlungen übersteigen zusammen den Posten → diese wird zurückgerollt", async () => {
    useFake(withItem());
    // Nach dem Anteils-Insert (Nachkontrolle) taucht eine parallele Zahlung auf.
    fake.onFrom("transaction_participants", 1, () =>
      fake.rows("transactions").push({ id: "parallel", trip_id: TRIP, type: "expense", item_id: ITEM, amount: 200, deleted_at: null }),
    );
    const res = await pay("200");
    expect(res.status).toBe("error");
    expect(fake.rows("transactions").map((t) => t.id)).toEqual(["parallel"]);
    expect(fake.rows("transaction_participants")).toHaveLength(0);
  });

  it("Race: ändert sich das Soll gleichzeitig, wird die Zahlung zurückgerollt", async () => {
    useFake(withItem());
    fake.onFrom("transaction_participants", 1, () => {
      const anna = fake.rows("prepayment_item_obligations").find((o) => o.person_id === ANNA)!;
      anna.amount = 120;
    });
    const res = await pay("300");
    expect(res.status).toBe("error");
    expect(fake.rows("transactions")).toHaveLength(0);
  });

  it("Rollback: scheitern die Anteile, verschwindet die Ausgabe wieder", async () => {
    useFake(withItem());
    fake.failOn({ table: "transaction_participants", action: "insert" });
    const res = await pay("300");
    expect(res.status).toBe("error");
    expect(fake.rows("transactions")).toHaveLength(0);
  });

  it("Retry mit gleichem idempotency_key bucht nicht doppelt", async () => {
    useFake(withItem());
    await pay("100", KEY1);
    const res = await pay("100", KEY1);
    expect(res).toMatchObject({ status: "ok", duplicate: true });
    expect(fake.rows("transactions")).toHaveLength(1);
    expect(fake.rows("transaction_participants")).toHaveLength(3);
  });

  it("ohne Empfänger-/Skipper-Recht → keine Ausgabe", async () => {
    useFake(withItem());
    mockedPayee.mockResolvedValue({ ok: false, message: "nope" });
    expect((await pay("100")).status).toBe("error");
    expect(fake.rows("transactions")).toHaveLength(0);
  });

  it("Posten ohne Soll → abgewiesen", async () => {
    useFake(withItem({ prepayment_item_obligations: [] }));
    expect((await pay("100")).status).toBe("error");
    expect(fake.rows("transactions")).toHaveLength(0);
  });
});
