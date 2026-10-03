// Posten-Erinnerungen (PR5) — reine Planungslogik, Templates, Push-Payloads.
// lib/prepayments/item-reminders.ts, lib/email/item-reminder-template.ts.
import { describe, expect, it } from "vitest";
import {
  ITEM_CREW_WINDOW_DAYS,
  ITEM_PAYEE_WINDOW_DAYS,
  inReminderWindow,
  planItemReminderJobs,
  tripAcceptsReminders,
  type ItemReminderInput,
} from "@/lib/prepayments/item-reminders";
import { addDays } from "@/lib/prepayments/dates";
import { renderItemCrewReminderMail, renderItemPayeeReminderMail } from "@/lib/email/item-reminder-template";
import { itemPayeeReminderPush, itemReminderPush } from "@/lib/notify/payloads";

const TODAY = "2027-03-10";
const TRIP = "trip-1";
const ITEM = "item-1";
const PAYEE = "payee";
const ANNA = "anna";
const BEN = "ben";

function input(overrides: Partial<ItemReminderInput> = {}, dueInDays = 5): ItemReminderInput {
  return {
    todayIso: TODAY,
    items: [
      { id: ITEM, trip_id: TRIP, label: "Flüge", total_amount: 300, due_date: addDays(TODAY, dueInDays), payee_person_id: PAYEE },
    ],
    trips: [{ id: TRIP, end_date: "2027-06-10", archived: false, retention_purged_at: null }],
    obligations: [
      { item_id: ITEM, person_id: PAYEE, amount: 100 },
      { item_id: ITEM, person_id: ANNA, amount: 100 },
      { item_id: ITEM, person_id: BEN, amount: 100 },
    ],
    payments: [],
    pending: [],
    providerPayments: [],
    sentLog: [],
    ...overrides,
  };
}

const crewJobs = (i: ItemReminderInput) => planItemReminderJobs(i).filter((j) => j.type === "item_crew_3d");
const payeeJobs = (i: ItemReminderInput) => planItemReminderJobs(i).filter((j) => j.type === "item_payee_3d");

describe("Fenster", () => {
  it("Konstanten: Crew 6 Tage (3 + 3 Puffer), Empfänger 3 Tage", () => {
    expect(ITEM_CREW_WINDOW_DAYS).toBe(6);
    expect(ITEM_PAYEE_WINDOW_DAYS).toBe(3);
  });

  it("inklusive Grenzen: Tag 0 und Tag N gehören dazu, N+1 und gestern nicht", () => {
    expect(inReminderWindow(TODAY, addDays(TODAY, 0), 6)).toBe(true);
    expect(inReminderWindow(TODAY, addDays(TODAY, 6), 6)).toBe(true);
    expect(inReminderWindow(TODAY, addDays(TODAY, 7), 6)).toBe(false);
    expect(inReminderWindow(TODAY, addDays(TODAY, -1), 6)).toBe(false);
    expect(inReminderWindow(TODAY, null, 6)).toBe(false);
  });

  it("Crew: genau 6 Tage vorher → erinnert, 7 Tage vorher → noch nicht", () => {
    expect(crewJobs(input({}, 6)).map((j) => j.personId).sort()).toEqual([ANNA, BEN]);
    expect(crewJobs(input({}, 7))).toEqual([]);
  });

  it("Empfänger: genau 3 Tage vorher → Übersicht, 4 Tage vorher → noch nicht", () => {
    expect(payeeJobs(input({}, 3))).toHaveLength(1);
    expect(payeeJobs(input({}, 4))).toEqual([]);
  });

  it("verpasster Cron-Tag: auch 2 Tage vor Fälligkeit (Fenster schon offen) wird noch erinnert", () => {
    expect(crewJobs(input({}, 2)).map((j) => j.personId).sort()).toEqual([ANNA, BEN]);
    expect(payeeJobs(input({}, 2))).toHaveLength(1);
  });

  it("verstrichene Fälligkeit → keine Erinnerung mehr", () => {
    expect(planItemReminderJobs(input({}, -1))).toEqual([]);
  });
});

describe("Crew-Auswahl", () => {
  it("Betrag = Soll − bestätigt, Soll wird mitgegeben", () => {
    const jobs = crewJobs(input({ payments: [{ item_id: ITEM, person_id: ANNA, paid_amount: 40 }] }));
    const anna = jobs.find((j) => j.personId === ANNA)!;
    expect(anna.amount).toBe(60);
    expect(anna.soll).toBe(100);
  });

  it("bezahlt und überzahlt → keine Erinnerung", () => {
    const jobs = crewJobs(
      input({
        payments: [
          { item_id: ITEM, person_id: ANNA, paid_amount: 100 },
          { item_id: ITEM, person_id: BEN, paid_amount: 150 },
        ],
      }),
    );
    expect(jobs).toEqual([]);
  });

  it("Pending-Awareness: offene Selbstmeldung → keine Erinnerung (auch bei Teilzahlung)", () => {
    const jobs = crewJobs(
      input({
        payments: [{ item_id: ITEM, person_id: BEN, paid_amount: 30 }],
        pending: [
          { item_id: ITEM, person_id: ANNA, amount: 100 },
          { item_id: ITEM, person_id: BEN, amount: 10 },
        ],
      }),
    );
    expect(jobs).toEqual([]);
  });

  it("Selbstmeldung eines ANDEREN Postens zählt nicht", () => {
    const jobs = crewJobs(input({ pending: [{ item_id: "anderer", person_id: ANNA, amount: 100 }] }));
    expect(jobs.map((j) => j.personId)).toContain(ANNA);
  });

  it("der Empfänger bekommt keine Crew-Erinnerung (zahlt nicht an sich selbst)", () => {
    expect(crewJobs(input()).map((j) => j.personId)).not.toContain(PAYEE);
  });

  it("Soll 0 → keine Erinnerung für diese Person; Posten ganz ohne Soll → gar nichts", () => {
    const zeroAnna = input({
      obligations: [
        { item_id: ITEM, person_id: ANNA, amount: 0 },
        { item_id: ITEM, person_id: BEN, amount: 300 },
      ],
    });
    expect(crewJobs(zeroAnna).map((j) => j.personId)).toEqual([BEN]);
    expect(planItemReminderJobs(input({ obligations: [] }, 2))).toEqual([]);
  });

  it("Dedup: schon erinnert → nicht erneut; andere Art bleibt unberührt", () => {
    const i = input(
      { sentLog: [{ item_id: ITEM, person_id: ANNA, reminder_type: "item_crew_3d" }, { item_id: ITEM, person_id: BEN, reminder_type: "item_payee_3d" }] },
      2,
    );
    expect(crewJobs(i).map((j) => j.personId)).toEqual([BEN]);
    expect(payeeJobs(i)).toHaveLength(1);
  });

  it("ohne Fälligkeit → keine Erinnerung", () => {
    const i = input();
    i.items[0].due_date = null;
    expect(planItemReminderJobs(i)).toEqual([]);
  });
});

describe("Törn-Zustand", () => {
  it("abgelaufen, archiviert, gepurged, unbekannt → übersprungen", () => {
    expect(tripAcceptsReminders({ id: TRIP, end_date: addDays(TODAY, -1), archived: false, retention_purged_at: null }, TODAY)).toBe(false);
    expect(tripAcceptsReminders({ id: TRIP, end_date: TODAY, archived: false, retention_purged_at: null }, TODAY)).toBe(true);
    for (const trip of [
      { id: TRIP, end_date: addDays(TODAY, -1), archived: false, retention_purged_at: null },
      { id: TRIP, end_date: null, archived: true, retention_purged_at: null },
      { id: TRIP, end_date: null, archived: false, retention_purged_at: "2027-01-01T00:00:00Z" },
    ]) {
      expect(planItemReminderJobs(input({ trips: [trip] }, 2))).toEqual([]);
    }
    expect(planItemReminderJobs(input({ trips: [] }, 2))).toEqual([]);
  });
});

describe("Empfänger-Übersicht", () => {
  it("Kennzahlen: Crew-Eingänge ohne Selbstverrechnung, eigener offener Anteil, Anbieter-Rest", () => {
    const [job] = payeeJobs(
      input(
        {
          payments: [
            { item_id: ITEM, person_id: ANNA, paid_amount: 100 },
            { item_id: ITEM, person_id: PAYEE, paid_amount: 40 },
          ],
          providerPayments: [{ item_id: ITEM, amount: 120 }],
        },
        1,
      ),
    );
    expect(job.personId).toBe(PAYEE);
    expect(job.amount).toBe(180);
    expect(job.overview).toEqual({
      providerSoll: 300,
      crewPaid: 100,
      crewSoll: 200,
      providerPaid: 120,
      providerOpen: 180,
      ownOpen: 60,
    });
  });

  it("Anbieter voll bezahlt → keine Übersicht (Pendant Advancer-Skip), Teilzahlungen werden summiert", () => {
    const paid = input({ providerPayments: [{ item_id: ITEM, amount: 200 }, { item_id: ITEM, amount: 100 }] }, 1);
    expect(payeeJobs(paid)).toEqual([]);
    const partly = input({ providerPayments: [{ item_id: ITEM, amount: 200 }] }, 1);
    expect(payeeJobs(partly)[0].amount).toBe(100);
  });

  it("Dedup der Übersicht", () => {
    const i = input({ sentLog: [{ item_id: ITEM, person_id: PAYEE, reminder_type: "item_payee_3d" }] }, 1);
    expect(payeeJobs(i)).toEqual([]);
  });
});

describe("Templates", () => {
  const evil = `<img src=x onerror="alert(1)">`;

  it("Crew-Mail escapt Label, Kategorie, Törnname und Namen im HTML", () => {
    const m = renderItemCrewReminderMail({
      recipientName: evil,
      payeeName: evil,
      tripName: evil,
      tripType: "sailing",
      item: { label: evil, categoryName: evil },
      crewDueDate: "7.3.2027",
      amountOpen: 60,
      amountSoll: 100,
      appUrl: "https://bordkasse.example/trips/t/prepayments",
    });
    expect(m.html).not.toContain("<img src=x");
    expect(m.html).toContain("&lt;img");
    expect(m.html).toContain("60,00");
    expect(m.html).toContain("7.3.2027");
    expect(m.text).toContain("(von 100,00");
  });

  it("Empfänger-Mail escapt alle freien Texte und nennt Soll/Eingänge/überwiesen/offen", () => {
    const m = renderItemPayeeReminderMail({
      recipientName: evil,
      tripName: evil,
      tripType: "other",
      item: { label: evil, categoryName: null },
      providerDueDate: "10.3.2027",
      providerSoll: 300,
      crewPaid: 100,
      crewSoll: 200,
      providerPaid: 120,
      providerOpen: 180,
      ownOpen: 60,
      appUrl: "https://bordkasse.example/trips/t/prepayments",
    });
    expect(m.html).not.toContain("<img src=x");
    for (const amount of ["300,00", "100,00", "200,00", "120,00", "180,00", "60,00"]) expect(m.html).toContain(amount);
    // Reise-Typ „other“: neutrales Vokabular (Reisegruppe/die Reise), kein Törn-Wort.
    expect(m.text).toContain("Reisegruppe");
    expect(m.text).toContain("die Reise");
    expect(m.text).not.toContain("den Törn");
    expect(m.html).toContain("Zahlungen öffnen");
    expect(m.text).toContain("Selbstverrechnung");
  });

  it("Empfänger-Mail ohne offenen Eigenanteil zeigt keinen Selbstverrechnungs-Hinweis", () => {
    const m = renderItemPayeeReminderMail({
      recipientName: "P",
      tripName: "T",
      tripType: "sailing",
      item: { label: "Flüge", categoryName: "An-/Abreise" },
      providerDueDate: "10.3.2027",
      providerSoll: 300,
      crewPaid: 200,
      crewSoll: 200,
      providerPaid: 0,
      providerOpen: 300,
      ownOpen: 0,
      appUrl: "https://x",
    });
    expect(m.html).not.toContain("Selbstverrechnung");
    expect(m.html).toContain("An-/Abreise: Flüge");
  });

  it("Push-Payloads verweisen auf die Anzahlungen-Seite, getrennte Tags", () => {
    const args = { itemLabel: "Flüge", amount: 60, tripName: "T", tripId: "t1", itemId: "i1" };
    expect(itemReminderPush(args).url).toBe("/trips/t1/prepayments");
    expect(itemReminderPush(args).tag).not.toBe(itemPayeeReminderPush(args).tag);
  });
});
