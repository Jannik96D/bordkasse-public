import { describe, it, expect } from "vitest";
import {
  ITEM_STATUS_META,
  buildSaveItemPayload,
  defaultItemCategoryId,
  evalItemAmount,
  individuellDiffCents,
  itemCellAriaLabel,
  itemLocks,
  itemOverallStatus,
  itemsNavRelevant,
  progressPercent,
  providerDueInfo,
  signedDaysBetween,
  type ItemFormState,
  type ItemLike,
} from "@/lib/prepayments/item-ui";
import { itemCellStatus } from "@/lib/calc/prepayment-item-shares";

const fmt = (n: number) => `${n.toFixed(2).replace(".", ",")} €`;
const de = (iso: string) => `D(${iso})`;

function cell(person_id: string, soll: number, paid: number, pending = 0) {
  return { person_id, soll, paid, pending, status: itemCellStatus(soll, paid, pending) };
}
function item(over: Partial<ItemLike> = {}): ItemLike {
  const cells = over.cells ?? [cell("a", 100, 100), cell("b", 100, 100)];
  const sollTotal = cells.reduce((s, c) => s + c.soll, 0);
  const paidTotal = cells.reduce((s, c) => s + c.paid, 0);
  return {
    id: "i1",
    total_amount: sollTotal,
    due_date: null,
    payee_person_id: "a",
    cells,
    sollTotal,
    paidTotal,
    pendingTotal: cells.reduce((s, c) => s + c.pending, 0),
    overpaidTotal: cells.reduce((s, c) => s + Math.max(0, c.paid - c.soll), 0),
    underpaidTotal: cells.reduce((s, c) => s + Math.max(0, c.soll - c.paid), 0),
    providerPaid: sollTotal,
    providerOpen: 0,
    providerOverdue: false,
    complete: true,
    ...over,
  };
}

describe("ITEM_STATUS_META", () => {
  it("jeder Status hat Symbol UND Text (nie nur Farbe)", () => {
    for (const s of ["open", "pending", "underpaid", "paid", "overpaid"] as const) {
      expect(ITEM_STATUS_META[s].glyph.length).toBeGreaterThan(0);
      expect(ITEM_STATUS_META[s].label.length).toBeGreaterThan(0);
    }
    expect(ITEM_STATUS_META.overpaid.label).toBe("überzahlt");
    expect(ITEM_STATUS_META.underpaid.label).toBe("teilweise bezahlt");
  });
});

describe("itemCellAriaLabel", () => {
  it("trägt Name, Posten, Status, Beträge und die Aktion", () => {
    const l = itemCellAriaLabel({ name: "Anna", itemLabel: "Flüge", status: "underpaid", soll: 100, paid: 40, pending: 0, fmt, actionable: true });
    expect(l).toBe("Anna, Flüge: teilweise bezahlt, 40,00 € von 100,00 € bezahlt, 60,00 € offen. Zahlung erfassen");
  });
  it("nennt Überzahlung und offene Meldung; ohne Aktion kein Aktionssatz", () => {
    const l = itemCellAriaLabel({ name: "Ben", itemLabel: "Bahn", status: "overpaid", soll: 50, paid: 80, pending: 10, fmt, actionable: false });
    expect(l).toContain("überzahlt");
    expect(l).toContain("30,00 € zu viel");
    expect(l).toContain("10,00 € gemeldet");
    expect(l).not.toContain("Zahlung erfassen");
    expect(l).not.toContain("offen");
  });
});

describe("itemOverallStatus", () => {
  it("abgeschlossen = complete", () => {
    expect(itemOverallStatus(item())).toBe("complete");
  });
  it("Überzahlung geht vor offenen Beträgen", () => {
    const it = item({ complete: false, cells: [cell("a", 100, 150), cell("b", 100, 20)] });
    expect(itemOverallStatus(it)).toBe("overpaid");
  });
  it("Gruppe schuldet noch → crew_open; offene Selbstmeldung zählt dazu", () => {
    expect(itemOverallStatus(item({ complete: false, cells: [cell("a", 100, 100), cell("b", 100, 0)] }))).toBe("crew_open");
    expect(itemOverallStatus(item({ complete: false, cells: [cell("a", 100, 100), cell("b", 100, 100, 0)], pendingTotal: 5 }))).toBe("crew_open");
  });
  it("Gruppe durch, Anbieter offen → provider_open", () => {
    expect(itemOverallStatus(item({ complete: false, providerPaid: 50, providerOpen: 150 }))).toBe("provider_open");
  });
  it("Anbieter überzahlt → overpaid", () => {
    expect(itemOverallStatus(item({ complete: false, providerPaid: 250 }))).toBe("overpaid");
  });
  it("ohne Soll → empty (nie fälschlich abgeschlossen)", () => {
    expect(itemOverallStatus(item({ complete: false, cells: [] }))).toBe("empty");
  });
});

describe("progressPercent", () => {
  it("klemmt und rechnet nie NaN", () => {
    expect(progressPercent(50, 200)).toBe(25);
    expect(progressPercent(300, 200)).toBe(100);
    expect(progressPercent(-5, 200)).toBe(0);
    expect(progressPercent(10, 0)).toBe(0);
  });
});

describe("providerDueInfo", () => {
  const today = "2026-10-02";
  it("bezahlt → done", () => {
    expect(providerDueInfo({ due_date: "2026-09-01", providerOpen: 0 }, today, de).kind).toBe("done");
  });
  it("überfällig mit Tagen und Singular", () => {
    expect(providerDueInfo({ due_date: "2026-10-01", providerOpen: 10 }, today, de)).toMatchObject({ kind: "overdue", daysLeft: -1, text: "seit 1 Tag überfällig" });
    expect(providerDueInfo({ due_date: "2026-09-27", providerOpen: 10 }, today, de).text).toBe("seit 5 Tagen überfällig");
  });
  it("heute / bald / später / ohne Fälligkeit", () => {
    expect(providerDueInfo({ due_date: today, providerOpen: 10 }, today, de)).toMatchObject({ kind: "soon", text: "heute fällig" });
    expect(providerDueInfo({ due_date: "2026-10-16", providerOpen: 10 }, today, de)).toMatchObject({ kind: "soon", text: "in 14 Tagen fällig" });
    expect(providerDueInfo({ due_date: "2026-10-17", providerOpen: 10 }, today, de)).toMatchObject({ kind: "open", text: "fällig D(2026-10-17)" });
    expect(providerDueInfo({ due_date: null, providerOpen: 10 }, today, de).kind).toBe("open");
  });
  it("signedDaysBetween ist zeitzonenfrei (Sommerzeitwechsel)", () => {
    expect(signedDaysBetween("2026-03-28", "2026-03-30")).toBe(2);
    expect(signedDaysBetween("2026-10-24", "2026-10-26")).toBe(2);
  });
});

describe("itemLocks", () => {
  it("frischer Posten: nichts gesperrt", () => {
    const l = itemLocks(item({ complete: false, providerPaid: 0, providerOpen: 200, cells: [cell("a", 100, 0), cell("b", 100, 0)] }));
    expect(l).toMatchObject({ distributionLocked: false, payeeLocked: false, deleteReason: null });
  });
  it("Anbieter-Zahlung sperrt Soll, Empfänger und Löschen — mit Begründung", () => {
    const l = itemLocks(item({ providerPaid: 10, cells: [cell("a", 100, 0), cell("b", 100, 0)] }));
    expect(l.distributionLocked).toBe(true);
    expect(l.distributionReason).toMatch(/Anbieter/);
    expect(l.payeeLocked).toBe(true);
    expect(l.deleteReason).toMatch(/bestätigte Zahlungen/);
  });
  it("bestätigte Crew-Zahlung sperrt Empfängerwechsel und Löschen, aber nicht das Soll", () => {
    const l = itemLocks(item({ providerPaid: 0, cells: [cell("a", 100, 30), cell("b", 100, 0)] }));
    expect(l.distributionLocked).toBe(false);
    expect(l.payeeLocked).toBe(true);
    expect(l.payeeReason).toMatch(/Zahlungen/);
    expect(l.deleteReason).not.toBeNull();
  });
  it("nur offene Selbstmeldung: Löschen mit eigener Begründung", () => {
    const l = itemLocks(item({ providerPaid: 0, pendingTotal: 20, cells: [cell("a", 100, 0, 20), cell("b", 100, 0)] }));
    expect(l.deleteReason).toMatch(/Selbstmeldung/);
    expect(l.payeeLocked).toBe(true);
  });
});

describe("evalItemAmount", () => {
  it("versteht Komma, Tausenderpunkt und Rechnen", () => {
    expect(evalItemAmount("3.700,00")).toBe(3700);
    expect(evalItemAmount("3.700")).toBe(3700);
    expect(evalItemAmount("12,5")).toBe(12.5);
    expect(evalItemAmount("1200 - 150,50")).toBe(1049.5);
    expect(evalItemAmount("480 / 4")).toBe(120);
  });
  it("lehnt Unsinn ab", () => {
    expect(evalItemAmount("")).toBeNull();
    expect(evalItemAmount("abc")).toBeNull();
    expect(evalItemAmount("2 +")).toBeNull();
  });
});

describe("individuellDiffCents", () => {
  it("Σ Einzelbeträge − Posten in Cent", () => {
    expect(individuellDiffCents(300, { a: "100", b: "100,00", c: "100" })).toBe(0);
    expect(individuellDiffCents(300, { a: "100", b: "90" })).toBe(-11000);
    expect(individuellDiffCents(300, { a: "150", b: "170,50" })).toBe(2050);
  });
  it("leere/ungültige Felder zählen 0; fehlender Betrag → ganze Summe als Differenz", () => {
    expect(individuellDiffCents(100, { a: "", b: "x", c: "100" })).toBe(0);
    expect(individuellDiffCents(null, { a: "10" })).toBe(1000);
  });
});

describe("buildSaveItemPayload", () => {
  const base: ItemFormState = {
    tripId: "t",
    id: "i",
    categoryId: "c",
    label: "  Flüge ",
    amountText: "1.200,50",
    dueDate: "2026-11-01",
    payeeId: "p",
    splitType: "gleichmaessig",
    amounts: {},
    redistribute: true,
    sortOrder: 2,
  };
  it("normalisiert Betrag/Label und überträgt die Felder", () => {
    const r = buildSaveItemPayload(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload).toMatchObject({ trip_id: "t", id: "i", label: "Flüge", total_amount: "1200,50", due_date: "2026-11-01", payee_person_id: "p", split_type: "gleichmaessig", redistribute: true, obligations: [] });
    }
  });
  it("leere Fälligkeit → null; leerer Empfänger → null (Server nimmt den Skipper)", () => {
    const r = buildSaveItemPayload({ ...base, dueDate: "", payeeId: "" });
    expect(r.ok && r.payload).toMatchObject({ due_date: null, payee_person_id: null });
  });
  it("individuell: nur befüllte Beträge >0, redistribute immer false", () => {
    const r = buildSaveItemPayload({ ...base, splitType: "individuell", amountText: "300", amounts: { a: "100", b: "", c: "0", d: "200" } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.obligations).toEqual([{ person_id: "a", amount: "100,00" }, { person_id: "d", amount: "200,00" }]);
      expect(r.payload.redistribute).toBe(false);
    }
  });
  it("Fehler mit Feldbezug", () => {
    expect(buildSaveItemPayload({ ...base, label: " " })).toMatchObject({ ok: false, field: "label" });
    expect(buildSaveItemPayload({ ...base, amountText: "0" })).toMatchObject({ ok: false, field: "total_amount" });
    expect(buildSaveItemPayload({ ...base, amountText: "x" })).toMatchObject({ ok: false, field: "total_amount" });
    expect(buildSaveItemPayload({ ...base, splitType: "individuell", amounts: { a: "abc" } })).toMatchObject({ ok: false, field: "obligations" });
    expect(buildSaveItemPayload({ ...base, splitType: "individuell", amounts: {} })).toMatchObject({ ok: false, field: "obligations" });
  });
});

describe("defaultItemCategoryId", () => {
  it("findet „An-/Abreise“ (auch mit Leerzeichen/Groß-Klein), sonst null", () => {
    expect(defaultItemCategoryId([{ id: "1", name: "Sprit" }, { id: "2", name: "An-/Abreise" }])).toBe("2");
    expect(defaultItemCategoryId([{ id: "3", name: "an- / abreise" }])).toBe("3");
    expect(defaultItemCategoryId([{ id: "1", name: "Reiseversicherung" }, { id: "4", name: "Abreise" }])).toBeNull();
  });
});

describe("itemsNavRelevant", () => {
  const open = item({ complete: false, cells: [cell("a", 100, 100), cell("b", 100, 0)] });
  it("Skipper/Admin: jeder nicht abgeschlossene Posten", () => {
    expect(itemsNavRelevant([open], { personId: "x", isManager: true })).toBe(true);
    expect(itemsNavRelevant([item()], { personId: "x", isManager: true })).toBe(false);
    expect(itemsNavRelevant([], { personId: "x", isManager: true })).toBe(false);
  });
  it("Crew: nur eigener offener Anteil oder offene Meldung", () => {
    expect(itemsNavRelevant([open], { personId: "b", isManager: false })).toBe(true);
    expect(itemsNavRelevant([open], { personId: "z", isManager: false })).toBe(false);
    expect(itemsNavRelevant([open], { personId: null, isManager: false })).toBe(false);
    const pend = item({ complete: false, cells: [cell("b", 100, 0, 100)] });
    expect(itemsNavRelevant([pend], { personId: "b", isManager: false })).toBe(true);
  });
  it("Empfänger sieht seinen unfertigen Posten, auch ohne eigenes Soll", () => {
    const it = item({ complete: false, payee_person_id: "p", cells: [cell("b", 100, 100)], providerPaid: 0, providerOpen: 100 });
    expect(itemsNavRelevant([it], { personId: "p", isManager: false })).toBe(true);
  });
  it("Crew: eigener bezahlter Anteil blendet den Tab nicht ein", () => {
    const notMine = { ...open, payee_person_id: "p" };
    expect(itemsNavRelevant([notMine], { personId: "a", isManager: false })).toBe(false);
  });
});
