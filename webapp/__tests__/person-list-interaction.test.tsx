// @vitest-environment happy-dom
/**
 * PR8 — Klick-Absicherung der Personenliste im Anzahlungsplan: das Abhaken der
 * Charter-Anzahlung läuft jetzt über die Liste statt über die Matrix-Zellen.
 * Geprüft wird, dass Zeilen-/Raten-Knopf den richtigen Dialog (Person + Rate)
 * öffnen und die Server-Action mit den richtigen IDs/Beträgen aufgerufen wird.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const recordPayment = vi.fn(async () => ({ status: "ok" as const }));
const submitSelfPayment = vi.fn(async () => ({ status: "ok" as const }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("@/lib/actions/prepayments", () => ({
  recordPayment: (...a: unknown[]) => (recordPayment as (...x: unknown[]) => unknown)(...a),
  submitSelfPayment: (...a: unknown[]) => (submitSelfPayment as (...x: unknown[]) => unknown)(...a),
  sendPrepaymentReminder: vi.fn(),
  confirmSelfPayment: vi.fn(),
  rejectSelfPayment: vi.fn(),
}));
vi.mock("@/lib/actions/prepayment-notify", () => ({ notifyItemCrew: vi.fn(), notifyPlanCrew: vi.fn() }));

import { PrepaymentMatrix } from "@/app/trips/[id]/prepayments/matrix";
import { CrewSelfView } from "@/app/trips/[id]/prepayments/crew-self-view";
import { TripVocabProvider } from "@/components/trip-vocab-provider";

const JAN = "aaaaaaaa-0000-4000-8000-000000000001";
const ANNA = "aaaaaaaa-0000-4000-8000-000000000002";
const plan = { trip_id: "t", split_method: "gleichmaessig", total_amount: 1000, advancer_person_id: JAN, wero_id: null, whatsapp_template: null } as never;
const tranches = [
  { id: "tr1", trip_id: "t", due_date: "2099-11-10", label: "1. Anzahlung", percent: 40, wero_request_link: null, sort_order: 0 },
  { id: "tr2", trip_id: "t", due_date: "2099-12-10", label: "Endzahlung", percent: 60, wero_request_link: null, sort_order: 1 },
];
const members = [{ id: JAN, display_name: "Jannik", email: "j@x.test" }, { id: ANNA, display_name: "Anna", email: "a@x.test" }];
const obligations = [
  { trip_id: "t", person_id: JAN, cabin_type_id: null, total_amount: 500 },
  { trip_id: "t", person_id: ANNA, cabin_type_id: null, total_amount: 500 },
];

let host: HTMLElement;
beforeEach(() => {
  recordPayment.mockClear();
  submitSelfPayment.mockClear();
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
});

function mount(node: React.ReactElement) {
  const root = createRoot(host);
  act(() => root.render(h(TripVocabProvider, { tripType: "sailing", children: node })));
  return root;
}
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const buttons = () => [...document.querySelectorAll("button")] as HTMLButtonElement[];
const byLabel = (re: RegExp) => buttons().find((b) => re.test(b.getAttribute("aria-label") ?? b.textContent ?? ""));
const click = (el: HTMLElement | undefined | null) => { expect(el, "Element nicht gefunden").toBeTruthy(); act(() => { el!.click(); }); };

function plant(over: Record<string, unknown> = {}) {
  return h(PrepaymentMatrix, {
    tripId: "t", tripName: "Ostsee", tripType: "sailing", plan, tranches, cabins: [], members, obligations,
    payments: [{ trip_id: "t", tranche_id: "tr1", person_id: ANNA, paid_amount: 200 }],
    pending: [], charterPaidByTranche: {}, canEditPlan: true, readOnly: false, lastNotifiedLabel: null, ...over,
  } as never);
}

describe("Anzahlungsplan: Personenliste", () => {
  it("zeigt eine Zeile pro Person, Raten sind zugeklappt und klappen auf", () => {
    mount(plant());
    expect(q('ul[aria-label^="Zahlungsstatus pro Person"]')).toBeTruthy();
    expect(document.body.textContent).not.toContain("Raten von Anna");
    click(byLabel(/Anna.*Raten anzeigen/));
    const rates = q('ul[aria-label="Raten von Anna"]');
    expect(rates?.textContent).toContain("1. Anzahlung");
    expect(rates?.textContent).toContain("Endzahlung");
    expect(rates?.textContent).toContain("bezahlt"); // 1. Anzahlung (200/200)
  });

  it("Rate-Knopf öffnet den Dialog genau dieser Person+Rate; Speichern ruft recordPayment mit deren IDs", async () => {
    mount(plant());
    click(byLabel(/Anna.*Raten anzeigen/));
    // 1. Anzahlung ist bezahlt → nur die Endzahlung hat einen Knopf
    expect(byLabel(/Einzahlung erfassen: Anna, 1\. Anzahlung/)).toBeUndefined();
    click(byLabel(/Einzahlung erfassen: Anna, Endzahlung/));
    expect(document.body.textContent).toContain("Einzahlung von Anna");
    expect(document.body.textContent).toContain("Endzahlung · fällig");
    await act(async () => { buttons().find((b) => b.textContent?.trim() === "Speichern")!.click(); });
    expect(recordPayment).toHaveBeenCalledTimes(1);
    const fd = (recordPayment.mock.calls[0] as unknown as [unknown, FormData])[1];
    expect(fd.get("person_id")).toBe(ANNA);
    expect(fd.get("tranche_id")).toBe("tr2");
    expect(fd.get("amount")).toBe("300,00");
  });

  it("Zeilen-Knopf bei einer offenen Rate öffnet direkt deren Dialog (ohne „Welche Rate?“)", () => {
    mount(plant());
    click(byLabel(/^Einzahlung erfassen: Anna, Yachtanzahlung/));
    expect(document.body.textContent).toContain("Einzahlung von Anna");
    expect(document.body.textContent).not.toContain("Welche Rate?");
  });

  it("Zeilen-Knopf bei mehreren offenen Raten fragt „Welche Rate?“ und öffnet dann die gewählte", () => {
    mount(plant({ payments: [] }));
    click(byLabel(/^Einzahlung erfassen: Anna, Yachtanzahlung/));
    expect(document.body.textContent).toContain("Welche Rate? Anna");
    click(buttons().find((b) => b.textContent?.startsWith("Endzahlung")));
    expect(document.body.textContent).toContain("Einzahlung von Anna");
    expect(document.body.textContent).toContain("Endzahlung · fällig");
  });

  it("die vorstreckende Person kann ihre eigene Rate abhaken (Selbstverrechnung)", () => {
    mount(plant({ payments: [] }));
    click(byLabel(/Jannik.*Raten anzeigen/));
    click(byLabel(/Einzahlung erfassen: Jannik, 1\. Anzahlung/));
    expect(document.body.textContent).toContain("Einzahlung von Jannik");
  });

  it("laufende Selbstmeldung: Skipper kann die Rate trotzdem erfassen, Status „gemeldet“ sichtbar", () => {
    mount(plant({
      payments: [],
      pending: [{ transaction_id: "x", trip_id: "t", tranche_id: "tr1", person_id: ANNA, amount: 200, date: "2099-01-02", note: null }],
    }));
    expect(q('ul[aria-label^="Zahlungsstatus pro Person"]')?.textContent).toContain("gemeldet");
    click(byLabel(/Anna.*Raten anzeigen/));
    expect(byLabel(/Einzahlung erfassen: Anna, 1\. Anzahlung/)).toBeTruthy();
  });

  it("archiviert: keine Einzahlung-erfassen-Knöpfe in der Liste", () => {
    mount(plant({ readOnly: true, payments: [] }));
    expect(byLabel(/^Einzahlung erfassen: Anna/)).toBeUndefined();
  });

  it("Matrix-Ansicht umschaltbar: Tabelle mit Zellen-Knöpfen, wieder zurück zur Liste", () => {
    mount(plant({ payments: [] }));
    expect(q("table")).toBeNull();
    click(buttons().find((b) => b.textContent?.includes("Matrix-Ansicht")));
    expect(q("table")).toBeTruthy();
    expect(q('ul[aria-label^="Zahlungsstatus pro Person"]')).toBeNull();
    click(byLabel(/Anna, 1\. Anzahlung: offen.*Einzahlung erfassen/));
    expect(document.body.textContent).toContain("Einzahlung von Anna");
    click(buttons().find((b) => b.textContent?.trim() === "Abbrechen"));
    click(buttons().find((b) => b.textContent?.includes("Listenansicht")));
    expect(q('ul[aria-label^="Zahlungsstatus pro Person"]')).toBeTruthy();
  });
});

describe("Crew-Ansicht Anzahlungsplan", () => {
  function crew(over: Record<string, unknown> = {}) {
    return h(CrewSelfView, {
      tripId: "t", plan, tranches, obligation: obligations[1], payments: [], pendingByTranche: {}, ...over,
    } as never);
  }

  it("meldet pro Rate: „Ich habe gezahlt“ ruft submitSelfPayment mit der Rate", async () => {
    mount(crew());
    // eigene Zeile ist aufgeklappt (defaultExpanded)
    click(byLabel(/Ich habe gezahlt: Du, Endzahlung/));
    expect(document.body.textContent).toContain("Einzahlung melden");
    await act(async () => { buttons().find((b) => b.textContent?.trim() === "Melden")!.click(); });
    const fd = (submitSelfPayment.mock.calls[0] as unknown as [unknown, FormData])[1];
    expect(fd.get("tranche_id")).toBe("tr2");
    expect(fd.get("amount")).toBe("300,00");
  });

  it("laufende Meldung: Knopf der Rate entfällt, Hinweis bleibt", () => {
    mount(crew({ pendingByTranche: { tr1: { amount: 200, date: "2099-01-02", tranche_id: "tr1", person_id: ANNA } } }));
    expect(byLabel(/Ich habe gezahlt: Du, 1\. Anzahlung/)).toBeUndefined();
    expect(byLabel(/Ich habe gezahlt: Du, Endzahlung/)).toBeTruthy();
    expect(document.body.textContent).toContain("wartet auf Bestätigung durch die vorstreckende Person");
  });
});
