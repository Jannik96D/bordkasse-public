/**
 * PR7 — Rendering-Absicherung der beiden Zahlungs-Karten (Anzahlungsplan +
 * weitere Zahlung), da es hier keine Browser-/Komponenten-Testumgebung gibt:
 * die Karten werden serverseitig zu statischem HTML gerendert (server-Actions
 * und next/navigation sind gemockt) und auf Anatomie, Wörter und die feste
 * Reihenfolge der Aktionsleiste geprüft.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("@/lib/actions/prepayment-items", () => ({
  confirmItemSelfPayment: vi.fn(),
  rejectItemSelfPayment: vi.fn(),
  deleteItem: vi.fn(),
  saveItem: vi.fn(),
  recordItemPayment: vi.fn(),
  submitItemSelfPayment: vi.fn(),
  recordItemProviderPayment: vi.fn(),
}));
vi.mock("@/lib/actions/prepayments", () => ({
  recordPayment: vi.fn(),
  sendPrepaymentReminder: vi.fn(),
  confirmSelfPayment: vi.fn(),
  rejectSelfPayment: vi.fn(),
  submitSelfPayment: vi.fn(),
}));
vi.mock("@/lib/actions/prepayment-item-reminder", () => ({ sendItemReminder: vi.fn() }));
vi.mock("@/lib/actions/prepayment-notify", () => ({ notifyItemCrew: vi.fn(), notifyPlanCrew: vi.fn() }));

import { ItemsSection } from "@/app/trips/[id]/prepayments/items-section";
import { PrepaymentMatrix } from "@/app/trips/[id]/prepayments/matrix";
import { TripVocabProvider } from "@/components/trip-vocab-provider";
import type { PrepaymentItemView } from "@/lib/queries/prepayment-items";

const ANNA = "aaaaaaaa-0000-4000-8000-000000000001";
const JAN = "aaaaaaaa-0000-4000-8000-000000000002";
const members = [
  { id: JAN, display_name: "Jannik" },
  { id: ANNA, display_name: "Anna" },
];

const item: PrepaymentItemView = {
  id: "item-1", trip_id: "t", category_id: "c", category_name: "An-/Abreise", category_icon: "Plane",
  label: "Flüge", total_amount: 360, due_date: "2099-10-12", payee_person_id: JAN, split_type: "gleichmaessig", sort_order: 0,
  cells: [
    { person_id: JAN, soll: 180, paid: 180, pending: 0, status: "paid" },
    { person_id: ANNA, soll: 180, paid: 0, pending: 0, status: "open" },
  ],
  sollTotal: 360, paidTotal: 180, pendingTotal: 0, overpaidTotal: 0, underpaidTotal: 180,
  pendingPayments: [], providerPaid: 0, providerOpen: 360, providerOverdue: false, complete: false,
};

function renderItems(over: Partial<Parameters<typeof ItemsSection>[0]> = {}, tripType = "sailing") {
  return renderToStaticMarkup(
    h(TripVocabProvider, {
      tripType,
      children: h(ItemsSection, {
        tripId: "t", items: [item], members, categories: [], viewerId: JAN, canManageItems: true, readOnly: false,
        defaultPayeeId: JAN, today: "2099-10-01", ...over,
      }),
    }),
  );
}

const plan = { trip_id: "t", split_method: "gleichmaessig", total_amount: 1000, advancer_person_id: JAN, wero_id: null, whatsapp_template: null } as never;
const tranches = [
  { id: "tr1", trip_id: "t", due_date: "2099-11-10", label: "1. Anzahlung", percent: 40, wero_request_link: null, sort_order: 0 },
  { id: "tr2", trip_id: "t", due_date: "2099-12-10", label: "Endzahlung", percent: 60, wero_request_link: null, sort_order: 1 },
];

function renderPlan(over: Record<string, unknown> = {}, tripType: "sailing" | "other" = "sailing") {
  return renderToStaticMarkup(
    h(TripVocabProvider, {
      tripType,
      children: h(PrepaymentMatrix, {
        tripId: "t", tripName: "Ostsee", tripType, plan, tranches, cabins: [],
        members: [{ id: JAN, display_name: "Jannik", email: "j@x.test" }, { id: ANNA, display_name: "Anna", email: "a@x.test" }],
        obligations: [{ trip_id: "t", person_id: JAN, cabin_type_id: null, total_amount: 500 }, { trip_id: "t", person_id: ANNA, cabin_type_id: null, total_amount: 500 }],
        payments: [], pending: [], charterPaidByTranche: {}, canEditPlan: true, readOnly: false, lastNotifiedLabel: null, ...over,
      } as never),
    }),
  );
}

/** Beschriftungen der Aktionsleiste (role=group „Aktionen“) in gerenderter Reihenfolge. */
function actionLabels(html: string): string[] {
  const start = html.indexOf('aria-label="Aktionen"');
  expect(start, "Aktionsleiste nicht gerendert").toBeGreaterThan(-1);
  const seg = html.slice(start, html.indexOf("</article>", start));
  const known = ["Einzahlung erfassen", "Crew informieren", "Bearbeiten", "Löschen"];
  return [...seg.matchAll(/>(Einzahlung erfassen|Crew informieren|Bearbeiten|Löschen)</g)].map((m) => m[1]).filter((l) => known.includes(l));
}

describe("weitere Zahlung (Karte)", () => {
  const html = renderItems();
  it("Abschnitt „Weitere Zahlungen“, Button „Weitere Zahlung hinzufügen“, kein „Posten“", () => {
    expect(html).toContain("Weitere Zahlungen");
    expect(html).toContain("Weitere Zahlung hinzufügen");
    expect(html).not.toMatch(/Posten|Empfängt|Empfänger/);
  });
  it("Kopf mit Badge „Streckt vor: Name“, zwei Fortschrittsbalken, Hinweisblock", () => {
    expect(html).toContain("Streckt vor: Jannik");
    expect(html).toContain("Von der Crew bezahlt");
    expect(html).toContain("An Anbieter bezahlt");
    expect(html).toContain("Noch an Anbieter zu überweisen");
    expect(html).toContain("Überweisung an Anbieter erfassen");
  });
  it("Aktionsleiste (gerendertes HTML) in fester Reihenfolge: Einzahlung erfassen · Crew informieren · Bearbeiten · Löschen", () => {
    expect(actionLabels(html)).toEqual(["Einzahlung erfassen", "Crew informieren", "Bearbeiten", "Löschen"]);
  });
  it("Crew sieht nur die eigene Zeile: „Ich habe gezahlt“, keine Skipper-Aktionsleiste", () => {
    const crew = renderItems({ viewerId: ANNA, canManageItems: false });
    expect(crew).toContain("Ich habe gezahlt");
    expect(crew).toContain("Einzahlung an");
    expect(crew).not.toContain("Crew informieren");
    expect(crew).not.toMatch(/Posten|Empfängt|Empfänger/);
  });
  it("Reise-Typ „other“ nutzt die Vokabeln der Reise", () => {
    const other = renderItems({}, "other");
    expect(other).toContain("Reisegruppe");
    expect(other).toContain("Von der Reisegruppe bezahlt");
    expect(other).not.toContain("Crew informieren");
    expect(other).toContain("Reisegruppe informieren");
  });
});

describe("Anzahlungsplan (Karte) hat dieselbe Anatomie", () => {
  const html = renderPlan();
  it("Titel aus dem Vokabular, Badge, zwei Balken, Hinweisblock mit gleichem Text", () => {
    expect(html).toContain("Yachtanzahlung");
    expect(html).toContain("Streckt vor: Jannik");
    expect(html).toContain("Von der Crew bezahlt");
    expect(html).toContain("An Anbieter bezahlt");
    expect(html).toContain("Noch an Anbieter zu überweisen");
    expect(html).toContain("Überweisung an Anbieter erfassen");
    expect(html).not.toMatch(/Vercharterer|Charteragentur/);
  });
  it("Aktionsleiste (gerendertes HTML): Einzahlung erfassen · Crew informieren · Bearbeiten (Plan bearbeiten wandert hierher)", () => {
    expect(actionLabels(html)).toEqual(["Einzahlung erfassen", "Crew informieren", "Bearbeiten"]);
    expect(html).not.toContain("Plan bearbeiten");
    expect(html).toContain("/trips/t/prepayments/setup");
  });
  it("Matrix bleibt Inhalt der Karte (Person × Rate)", () => {
    expect(html).toContain("1. Anzahlung");
    expect(html).toContain("Endzahlung");
    expect(html).toContain("Anna");
  });
  it("Reise-Typ „other“: Urlaubsanzahlung statt Yachtanzahlung", () => {
    const other = renderPlan({}, "other");
    expect(other).toContain("Urlaubsanzahlung");
    expect(other).not.toContain("Yachtanzahlung");
  });
  it("Archiviert/ohne Rechte: keine Bearbeiten-/Informieren-Aktion", () => {
    const ro = renderPlan({ readOnly: true });
    expect(ro).not.toContain("Crew informieren");
    expect(ro).not.toContain("/prepayments/setup");
    const crewMgr = renderPlan({ canEditPlan: false });
    expect(crewMgr).not.toContain("Crew informieren");
    expect(crewMgr).toContain("Einzahlung erfassen");
  });
});

describe("Plan-Karte: Rundungsrand bei „Noch an Anbieter zu überweisen“", () => {
  const third = [
    { id: "a", trip_id: "t", due_date: "2099-11-10", label: "1. Anzahlung", percent: 100 / 3, wero_request_link: null, sort_order: 0 },
    { id: "b", trip_id: "t", due_date: "2099-12-10", label: "2. Anzahlung", percent: 100 / 3, wero_request_link: null, sort_order: 1 },
    { id: "c", trip_id: "t", due_date: "2100-01-10", label: "Endzahlung", percent: 100 / 3, wero_request_link: null, sort_order: 2 },
  ];
  const hundred = { ...(plan as object), total_amount: 100 } as never;

  it("3 × 33,33 € voll überwiesen: nichts offen, kein Button, Status nicht „Anbieter noch nicht bezahlt“", () => {
    const html = renderPlan({ plan: hundred, tranches: third, charterPaidByTranche: { a: 33.33, b: 33.33, c: 33.33 } });
    expect(html).toContain("vollständig an den Anbieter überwiesen");
    expect(html).not.toContain("Überweisung an Anbieter erfassen");
    expect(html).not.toContain("Anbieter noch nicht bezahlt");
  });
  it("Gegenprobe: 0,02 € Rest bleibt offen (Button, Betrag)", () => {
    const html = renderPlan({ plan: hundred, tranches: third, charterPaidByTranche: { a: 33.33, b: 33.33, c: 33.31 } });
    expect(html).toContain("Überweisung an Anbieter erfassen");
    expect(html).not.toContain("vollständig an den Anbieter überwiesen");
  });
});

describe("Plan-Karte und weitere Zahlung teilen dieselben Elemente (PR8b)", () => {
  const plan1 = renderPlan({ payments: [{ trip_id: "t", tranche_id: "tr1", person_id: ANNA, paid_amount: 200 }] });
  const item1 = renderItems();
  const pendingPlan = renderPlan({ pending: [{ transaction_id: "x", tranche_id: "tr1", person_id: ANNA, amount: 200, date: "2099-01-02", description: null, created_at: "" }] });
  const pendingItem = renderItems({
    items: [{ ...item, pendingPayments: [{ transaction_id: "y", person_id: ANNA, amount: 180, date: "2099-01-02", created_at: "" }] }],
  });

  it("gleiche Kennzahlenzeile und gleiche Personenliste", () => {
    expect(plan1).toMatch(/von 2 vollständig/);
    expect(item1).toMatch(/von 2 vollständig/);
    expect(plan1).toContain('aria-label="Zahlungsstatus pro Person');
    expect(item1).toContain('aria-label="Zahlungsstatus pro Person');
  });
  it("keine Matrix-Tabelle, kein Ansichts-Umschalter", () => {
    expect(plan1).not.toContain("<table");
    expect(plan1).not.toMatch(/Matrix-Ansicht|Listenansicht/);
  });
  it("gleicher Banner für gemeldete Einzahlungen mit Bestätigen/Ablehnen", () => {
    for (const html of [pendingPlan, pendingItem]) {
      expect(html).toContain("1 Meldung wartet auf Bestätigung");
      expect(html).toMatch(/Meldung von Anna über [\d,.]+\s?€ bestätigen/);
      expect(html).toMatch(/Meldung von Anna über [\d,.]+\s?€ ablehnen/);
    }
  });
  it("gleicher Überzahlungs-Hinweis", () => {
    const over = renderPlan({ payments: [{ trip_id: "t", tranche_id: "tr1", person_id: ANNA, paid_amount: 250 }] });
    expect(over).toContain("zu viel bezahlt");
    const overItem = renderItems({ items: [{ ...item, cells: [{ person_id: JAN, soll: 180, paid: 200, pending: 0, status: "overpaid" }, item.cells[1]] }] });
    expect(overItem).toContain("zu viel bezahlt");
  });
});

describe("Erinnerungs-Glocke + Legende in beiden Karten (PR8c)", () => {
  it("weitere Zahlung: Glocke je Person + Legende; ohne E-Mail deaktiviert, Crew-Karte ohne", () => {
    const html = renderItems({ members: [{ id: JAN, display_name: "Jannik" }, { id: ANNA, display_name: "Anna", hasEmail: false } as never] });
    expect(html).toContain('aria-label="E-Mail fehlt"');
    expect(html).toContain("Übersicht an Jannik schicken");
    expect(html).toContain("Was bedeuten die Symbole?");
    expect(html).toContain("Erinnerung per Mail");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="E-Mail fehlt"/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*aria-label="Übersicht an Jannik/);
    const noDue = renderItems({ items: [{ ...item, due_date: null }] });
    expect(noDue).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Ohne Frist keine Erinnerung/);
    const crew = renderItems({ viewerId: ANNA, canManageItems: false });
    expect(crew).not.toContain("Was bedeuten die Symbole?");
  });
  it("Plan: Glocke + Legende, gleiche Wörter", () => {
    const html = renderPlan();
    expect(html).toContain("Was bedeuten die Symbole?");
    expect(html).toContain("Erinnerung per Mail");
  });
  it("archiviert: keine Glocke bei weiteren Zahlungen", () => {
    const html = renderItems({ readOnly: true });
    expect(html).not.toContain("Übersicht an Jannik schicken");
    expect(html).not.toContain("Was bedeuten die Symbole?");
  });
});
