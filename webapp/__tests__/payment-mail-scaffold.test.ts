/**
 * PR7 — ein Gerüst für alle Zahlungs-Mails (Anzahlungsplan + weitere
 * Zahlungen): Betreff-Muster, feste Blöcke „Dein Anteil · Bis wann · An wen ·
 * So geht's", Status-Wörter, CTA, Wero-Regel und „kein ‚Posten' in Mails/Pushs".
 */
import { describe, it, expect } from "vitest";
import {
  renderItemAnnounceCrewMail,
  renderItemAnnouncePayeeMail,
  renderPlanAnnounceAdvancerMail,
  renderPlanAnnounceCrewMail,
} from "@/lib/email/announce-templates";
import { renderItemNoticeMail, renderItemPendingMail } from "@/lib/email/item-notice-template";
import { renderItemCrewReminderMail, renderItemPayeeReminderMail } from "@/lib/email/item-reminder-template";
import { renderPaymentPendingMail } from "@/lib/email/payment-pending-template";
import { renderPrepaymentNoticeMail } from "@/lib/email/prepayment-notice-template";
import { renderPrepaymentReminderMail } from "@/lib/email/prepayment-reminder-template";
import { renderCharterReminderMail } from "@/lib/email/charter-reminder-template";
import { PAYMENT_STATUS, advanceSubject, eventSubject, shareSubject } from "@/lib/email/payment-mail";
import {
  charterReminderPush,
  itemAnnouncedPush,
  itemPayeeReminderPush,
  itemPaymentNoticePush,
  itemPaymentPendingPush,
  itemReminderPush,
  paymentConfirmedPush,
  paymentPendingPush,
  paymentRejectedPush,
  planAnnouncedPush,
  prepaymentReminderPush,
} from "@/lib/notify/payloads";

const nb = (s: string) => s.replace(/ /g, " ");
const URL = "https://bordkasse.example/trips/t/prepayments";
const item = { label: "Flüge", categoryName: "An-/Abreise" };

type Mail = { html: string; text: string; subject: string };

/** Jede Mail-Funktion mit Beispieldaten — beide Reise-Typen, mit/ohne Wero-ID. */
function allMails(tripType: "sailing" | "other", weroId: string | null): Record<string, Mail> {
  const base = { tripName: "Ostsee", tripType, appUrl: URL };
  return {
    itemCrew: renderItemAnnounceCrewMail({ ...base, isUpdate: false, recipientName: "Anna", payeeName: "Jannik", item, amount: 180, crewDue: "9.10.2026", weroId }),
    itemCrewUpdate: renderItemAnnounceCrewMail({ ...base, isUpdate: true, recipientName: "Anna", payeeName: "Jannik", item, amount: 180, crewDue: null, weroId }),
    itemPayee: renderItemAnnouncePayeeMail({ ...base, isUpdate: false, recipientName: "Jannik", item, total: 540, providerDue: "12.10.2026", rows: [{ name: "Anna", amount: 180 }], ownAmount: 180 }),
    planCrew: renderPlanAnnounceCrewMail({
      ...base, isUpdate: false, recipientName: "Anna", advancerName: "Jannik", total: 500,
      tranches: [{ label: "1. Anzahlung", amount: 200, crewDue: "7.1.2027" }, { label: "Endzahlung", amount: 300, crewDue: "7.4.2027" }], weroId,
    }),
    planCrewUpdate: renderPlanAnnounceCrewMail({
      ...base, isUpdate: true, recipientName: "Anna", advancerName: "Jannik", total: 500,
      tranches: [{ label: "Endzahlung", amount: 500, crewDue: "7.4.2027" }], weroId,
    }),
    planAdvancer: renderPlanAnnounceAdvancerMail({
      ...base, isUpdate: false, recipientName: "Jannik", providerTotal: 1000,
      tranches: [{ label: "1. Anzahlung", charterDue: "10.1.2027", toProvider: 400, fromCrew: 300 }], rows: [{ name: "Anna", amount: 200 }], ownAmount: 100,
    }),
    itemPending: renderItemPendingMail({ ...base, recipientName: "Jannik", reporterName: "Anna", item, amount: 180, date: "1.10.2026", note: "via Wero" }),
    itemNotice: renderItemNoticeMail({ ...base, kind: "item_payment_confirmed", role: "payer", recipientName: "Anna", actorName: "Jannik", payerName: "Anna", payeeName: "Jannik", item, amount: 180 }),
    itemNoticeRejected: renderItemNoticeMail({ ...base, kind: "item_payment_rejected", role: "payee", recipientName: "Jannik", actorName: "Admin", payerName: "Anna", payeeName: "Jannik", item, amount: 180 }),
    itemCrewReminder: renderItemCrewReminderMail({ ...base, recipientName: "Anna", payeeName: "Jannik", item, crewDueDate: "9.10.2026", amountOpen: 180, amountSoll: 180 }),
    itemPayeeReminder: renderItemPayeeReminderMail({ ...base, recipientName: "Jannik", item, providerDueDate: "12.10.2026", providerSoll: 540, crewPaid: 180, crewSoll: 360, providerPaid: 0, providerOpen: 540, ownOpen: 0 }),
    planPending: renderPaymentPendingMail({ skipperName: "Jannik", reporterName: "Anna", tripName: "Ostsee", trancheLabel: "1. Anzahlung", trancheDueDate: "10.1.2027", amount: 200, appUrl: URL, tripType }),
    planNotice: renderPrepaymentNoticeMail({ kind: "payment_rejected", recipientName: "Anna", actorName: "Admin", subjectPersonName: "Anna", amount: 200, trancheLabel: "1. Anzahlung", tripName: "Ostsee", appUrl: URL, tripType }),
    planReminder: renderPrepaymentReminderMail({
      recipientName: "Anna", tripName: "Ostsee", tripType, appUrl: URL, advancerName: "Jannik", weroId,
      tranches: [{ label: "1. Anzahlung", due_date: "7.1.2027", amount_due: 200, amount_total: 200 }],
    }),
    charterReminder: renderCharterReminderMail({
      recipientName: "Jannik", tripName: "Ostsee", tripType, appUrl: URL, isAutomated: true,
      tranches: [{ label: "1. Anzahlung", charter_due_date: "10.1.2027", soll_to_agency: 400, crew_paid_to_advancer: 100, crew_total_due: 300, paid_to_agency: 0, remaining_to_agency: 400 }],
    }),
  };
}

describe("Gerüst-Helfer: Betreff-Muster", () => {
  it("Anteil-Mail: „{Was}: dein Anteil {Betrag} bis {Datum}“, ohne Datum „Frist folgt“, Update „Geändert: “", () => {
    expect(nb(shareSubject({ what: "Flüge", amount: 180, due: "12.10." }))).toBe("Flüge: dein Anteil 180,00 € bis 12.10.");
    expect(nb(shareSubject({ what: "Flüge", amount: 180, due: null }))).toBe("Flüge: dein Anteil 180,00 € – Frist folgt");
    expect(nb(shareSubject({ what: "Flüge", amount: 180, due: "12.10.", isUpdate: true }))).toBe("Geändert: Flüge: dein Anteil 180,00 € bis 12.10.");
    expect(nb(shareSubject({ what: "Flüge", amount: 180, due: "12.10.", isReminder: true }))).toBe("Erinnerung: Flüge: dein Anteil 180,00 € bis 12.10.");
  });
  it("Vorstreck-Mail und Ereignis-Mail", () => {
    expect(nb(advanceSubject({ what: "Yachtanzahlung", amount: 1000, due: "10.1.2027" }))).toBe("Yachtanzahlung: du streckst 1.000,00 € vor – bis 10.1.2027");
    expect(nb(advanceSubject({ what: "Flüge", amount: 1, due: null }))).toContain("Frist folgt");
    expect(nb(eventSubject({ what: "Flüge", kind: "pending", who: "Anna", amount: 180 }))).toBe(`Flüge: 180,00 € von Anna – ${PAYMENT_STATUS.pending}`);
    expect(nb(eventSubject({ what: "Flüge", kind: "confirmed", who: "Anna", amount: 180 }))).toBe("Flüge: 180,00 € von Anna – bestätigt");
    expect(nb(eventSubject({ what: "Flüge", kind: "rejected", who: "Anna", amount: 180 }))).toBe("Flüge: 180,00 € von Anna – abgelehnt");
  });
});

describe("Alle Zahlungs-Mails: gleiches Gerüst", () => {
  for (const tripType of ["sailing", "other"] as const) {
    for (const weroId of [null, "   ", "WERO-1"]) {
      const hasWero = !!weroId?.trim();
      const label = `${tripType}, ${hasWero ? "mit" : "ohne"} Wero-ID${weroId === "   " ? " (nur Leerzeichen)" : ""}`;
      const mails = allMails(tripType, weroId);

      it(`kein „Posten“ in Betreff, HTML und Text (${label})`, () => {
        for (const [name, m] of Object.entries(mails)) {
          expect(m.subject, name).not.toMatch(/Posten/i);
          expect(m.html, name).not.toMatch(/Posten/i);
          expect(m.text, name).not.toMatch(/Posten/i);
          // Anbieter heißt immer „Anbieter“.
          expect(m.text + m.html, name).not.toMatch(/Vercharterer|Charteragentur/);
        }
      });

      it(`einheitlicher CTA „Zahlungen öffnen“ in jeder Mail (${label})`, () => {
        for (const [name, m] of Object.entries(mails)) {
          expect(m.html, name).toContain("Zahlungen öffnen");
          expect(m.text, name).toContain(`Zahlungen öffnen: ${URL}`);
        }
      });

      it(`Wero-Regel: ohne Wero-ID nirgends „Wero“, mit ID in den Zahlungsweg-Mails (${label})`, () => {
        const shareMails = ["itemCrew", "planCrew", "planReminder"];
        if (!hasWero) {
          for (const m of Object.values(mails)) {
            // „Wero“ darf auch in der freien Notiz („via Wero“) auftauchen — die Notiz ist Nutzereingabe.
            const withoutNote = m.text.replace(/Notiz von .*\n/g, "");
            expect(withoutNote.toLowerCase(), m.subject).not.toContain("wero");
          }
        } else {
          for (const name of shareMails) expect(mails[name].text, name).toContain("Wero-ID (Jannik): WERO-1");
        }
      });
    }
  }

  it("Anteil-Mails: Blöcke „Dein Anteil · Bis wann · An wen · So geht's“ in dieser Reihenfolge", () => {
    const mails = allMails("sailing", "W-1");
    for (const name of ["itemCrew", "planCrew", "planReminder"]) {
      const t = mails[name].text;
      const order = ["Dein Anteil:", "Bis wann:", "An wen:", "So geht's:"].map((k) => t.indexOf(k));
      expect(order.every((i) => i >= 0), `${name}: ${order}`).toBe(true);
      expect([...order].sort((a, b) => a - b), name).toEqual(order);
      // Gleiche Reihenfolge im HTML.
      const h = mails[name].html;
      const ho = ["Dein Anteil", "Bis wann", "An wen", "So geht's"].map((k) => h.indexOf(k));
      expect([...ho].sort((a, b) => a - b), `${name} html`).toEqual(ho);
    }
  });

  it("Vorstreck-Mails (Plan UND weitere Zahlung): „Du streckst vor · Bis wann · An wen“ + So geht's", () => {
    const mails = allMails("sailing", null);
    for (const name of ["itemPayee", "planAdvancer", "itemPayeeReminder", "charterReminder"]) {
      const t = mails[name].text;
      expect(t, name).toContain("Du streckst vor:");
      expect(t, name).toContain("An wen: Anbieter");
      const order = ["Du streckst vor:", "Bis wann:", "An wen:", "So geht's:"].map((k) => t.indexOf(k));
      expect(order.every((i) => i >= 0), name).toBe(true);
      expect([...order].sort((a, b) => a - b), name).toEqual(order);
    }
  });

  it("Betreffe: gleiches Muster für Plan und weitere Zahlung, Update mit „Geändert: “", () => {
    const m = allMails("sailing", null);
    expect(nb(m.itemCrew.subject)).toBe("Flüge: dein Anteil 180,00 € bis 9.10.2026");
    expect(nb(m.planCrew.subject)).toBe("Yachtanzahlung: dein Anteil 500,00 € bis 7.1.2027");
    expect(nb(m.itemCrewUpdate.subject)).toBe("Geändert: Flüge: dein Anteil 180,00 € – Frist folgt");
    expect(nb(m.planCrewUpdate.subject)).toBe("Geändert: Yachtanzahlung: dein Anteil 500,00 € bis 7.4.2027");
    expect(nb(m.itemPayee.subject)).toBe("Flüge: du streckst 540,00 € vor – bis 12.10.2026");
    expect(nb(m.planAdvancer.subject)).toBe("Yachtanzahlung: du streckst 1.000,00 € vor – bis 10.1.2027");
    expect(nb(m.itemCrewReminder.subject)).toBe("Erinnerung: Flüge: dein Anteil 180,00 € bis 9.10.2026");
    expect(nb(m.planReminder.subject)).toBe("Erinnerung: Yachtanzahlung: dein Anteil 200,00 € bis 7.1.2027");
    // Reise-Typ „other“ über das Vokabular, nichts hartkodiert.
    expect(nb(allMails("other", null).planCrew.subject)).toBe("Urlaubsanzahlung: dein Anteil 500,00 € bis 7.1.2027");
  });

  it("Status-Wörter einheitlich in Betreff und Faktenkarte (Plan UND weitere Zahlung)", () => {
    const m = allMails("sailing", null);
    for (const name of ["itemPending", "planPending"]) {
      expect(m[name].subject, name).toContain(PAYMENT_STATUS.pending);
      expect(m[name].text, name).toContain(`Status: ${PAYMENT_STATUS.pending}`);
    }
    expect(m.itemNotice.subject).toContain("– bestätigt");
    expect(m.itemNotice.text).toContain("Status: bestätigt");
    for (const name of ["itemNoticeRejected", "planNotice"]) {
      expect(m[name].subject, name).toContain("– abgelehnt");
      expect(m[name].text, name).toContain("Status: abgelehnt");
    }
  });
});

describe("Pushs: nennen die Sache + Betrag/Frist, nie „Posten“", () => {
  const base = { tripName: "Ostsee", tripId: "t" };
  const pushes = [
    prepaymentReminderPush({ ...base, trancheLabel: "1. Anzahlung", amount: 200, trancheId: "x", due: "7.1.2027" }),
    charterReminderPush({ ...base, trancheId: "x", amount: 400, due: "10.1.2027", what: "Yachtanzahlung" }),
    itemReminderPush({ ...base, itemLabel: "Flüge", amount: 180, itemId: "i", due: "9.10.2026" }),
    itemPayeeReminderPush({ ...base, itemLabel: "Flüge", amount: 540, itemId: "i", due: "12.10.2026" }),
    paymentPendingPush({ payerName: "Anna", amount: 200, tripId: "t", trancheId: "x", payerPersonId: "p", what: "1. Anzahlung" }),
    paymentConfirmedPush({ amount: 200, tripId: "t" }),
    paymentRejectedPush({ amount: 200, tripId: "t" }),
    itemPaymentPendingPush({ payerName: "Anna", itemLabel: "Flüge", amount: 180, tripId: "t", itemId: "i", payerPersonId: "p" }),
    itemPaymentNoticePush({ kind: "item_payment_recorded", role: "payer", payerName: "Anna", itemLabel: "Flüge", amount: 180, tripId: "t" }),
    itemPaymentNoticePush({ kind: "item_payment_confirmed", role: "payee", payerName: "Anna", itemLabel: "Flüge", amount: 180, tripId: "t" }),
    itemPaymentNoticePush({ kind: "item_payment_rejected", role: "payer", payerName: "Anna", itemLabel: "Flüge", amount: 180, tripId: "t" }),
    itemAnnouncedPush({ ...base, isUpdate: false, itemLabel: "Flüge", amount: 180, itemId: "i", due: "9.10.2026" }),
    itemAnnouncedPush({ ...base, isUpdate: true, itemLabel: "Flüge", amount: null, itemId: "i" }),
    planAnnouncedPush({ ...base, isUpdate: false, amount: 500, what: "Yachtanzahlung", due: "7.1.2027" }),
    planAnnouncedPush({ ...base, isUpdate: true, amount: null }),
  ];

  it("kein „Posten“, kein „Vercharterer“", () => {
    for (const p of pushes) {
      expect(`${p.title} ${p.body}`).not.toMatch(/Posten|Vercharterer|Charteragentur/);
    }
  });

  it("Anteil-Pushs: Titel „{Was}: dein Anteil {Betrag}“, Body mit Frist bzw. „Frist folgt“", () => {
    const a = itemAnnouncedPush({ ...base, isUpdate: false, itemLabel: "Flüge", amount: 180, itemId: "i", due: "9.10.2026" });
    expect(nb(a.title)).toBe("Flüge: dein Anteil 180,00 €");
    expect(a.body).toContain("Bis 9.10.2026");
    const b = itemAnnouncedPush({ ...base, isUpdate: true, itemLabel: "Flüge", amount: 180, itemId: "i" });
    expect(nb(b.title)).toBe("Geändert: Flüge: dein Anteil 180,00 €");
    expect(b.body).toContain("Frist folgt");
    const plan = planAnnouncedPush({ ...base, isUpdate: false, amount: 500, what: "Urlaubsanzahlung", due: "7.1.2027" });
    expect(nb(plan.title)).toBe("Urlaubsanzahlung: dein Anteil 500,00 €");
  });

  it("Status-Wörter in den Pushs", () => {
    expect(paymentPendingPush({ payerName: "Anna", amount: 1, tripId: "t", trancheId: "x", payerPersonId: "p" }).body).toContain(PAYMENT_STATUS.pending);
    expect(itemPaymentPendingPush({ payerName: "Anna", itemLabel: "Flüge", amount: 1, tripId: "t", itemId: "i", payerPersonId: "p" }).body).toContain(PAYMENT_STATUS.pending);
    expect(paymentConfirmedPush({ amount: 1, tripId: "t" }).title).toContain("bestätigt");
    expect(paymentRejectedPush({ amount: 1, tripId: "t" }).title).toContain("abgelehnt");
  });
});

describe("Bereits bezahlter Anteil: Zeile „Status“ statt Satz in „Bis wann“ (Plan UND weitere Zahlung)", () => {
  const base = { tripName: "Ostsee", tripType: "sailing" as const, appUrl: URL, recipientName: "Anna", weroId: null };
  const itemPaid = renderItemAnnounceCrewMail({ ...base, isUpdate: true, payeeName: "Jannik", item, amount: 180, paid: 180, crewDue: "9.10.2026" });
  const planPaid = renderPlanAnnounceCrewMail({
    ...base, isUpdate: true, advancerName: "Jannik", total: 200,
    tranches: [{ label: "Endzahlung", amount: 200, paid: 200, crewDue: "7.4.2027" }],
  });
  const planPending = renderPlanAnnounceCrewMail({
    ...base, isUpdate: true, advancerName: "Jannik", total: 200,
    tranches: [{ label: "Endzahlung", amount: 200, pending: 200, crewDue: "7.4.2027" }],
  });
  it("Reihenfolge Dein Anteil · Status · An wen, kein „Bis wann“, kein So-geht's", () => {
    for (const m of [itemPaid, planPaid]) {
      expect(m.text).toContain("Status: bereits vollständig bezahlt");
      expect(m.text).not.toContain("Bis wann");
      expect(m.text).not.toContain("So geht's");
      const o = ["Dein Anteil:", "Status:", "An wen:"].map((k) => m.text.indexOf(k));
      expect([...o].sort((a, b) => a - b)).toEqual(o);
      expect(o.every((i) => i >= 0)).toBe(true);
    }
    expect(planPending.text).toContain(`Status: ${PAYMENT_STATUS.pending}`);
  });
});

describe("Reise-Typ other: Fließtext der Plan-Mails nutzt vocab.prepayment", () => {
  const base = { tripName: "Rom", tripType: "other" as const, appUrl: URL };
  it("Crew- und Vorstreck-Mail, auch als Update", () => {
    const mails = [
      renderPlanAnnounceCrewMail({ ...base, isUpdate: true, recipientName: "Anna", advancerName: "Jannik", total: 100, tranches: [{ label: "Endzahlung", amount: 100, crewDue: "1.2.2027" }], weroId: null }),
      renderPlanAnnounceCrewMail({ ...base, isUpdate: false, recipientName: "Anna", advancerName: "Jannik", total: 100, tranches: [{ label: "Endzahlung", amount: 100, crewDue: "1.2.2027" }], weroId: null }),
      renderPlanAnnounceAdvancerMail({ ...base, isUpdate: true, recipientName: "Jannik", providerTotal: 100, tranches: [{ label: "Endzahlung", charterDue: "1.2.2027", toProvider: 100, fromCrew: 50 }], rows: [], ownAmount: 0 }),
      renderPlanAnnounceAdvancerMail({ ...base, isUpdate: false, recipientName: "Jannik", providerTotal: 100, tranches: [{ label: "Endzahlung", charterDue: "1.2.2027", toProvider: 100, fromCrew: 50 }], rows: [], ownAmount: 0 }),
    ];
    for (const m of mails) {
      expect(m.text).toContain("Urlaubsanzahlung");
      expect(m.text).not.toMatch(/Anzahlungsplan|Yacht/);
      expect(m.html).not.toMatch(/Anzahlungsplan|Yacht/);
    }
  });
});

describe("Betreff-/Titel-Sicherheit (Header-Injection)", () => {
  const evil = "Flüge\r\nBcc: x@y.z\tX";
  it("keine CR/LF/Tabs im Betreff, Länge begrenzt", () => {
    const long = "A".repeat(500);
    const subjects = [
      shareSubject({ what: evil, amount: 1, due: "1.1.\r\nBcc: a@b.c" }),
      advanceSubject({ what: evil, amount: 1, due: null }),
      eventSubject({ what: evil, kind: "pending", who: evil, amount: 1 }),
      shareSubject({ what: long, amount: 1, due: null }),
      renderItemPendingMail({ tripName: "T", tripType: "sailing", appUrl: URL, recipientName: "J", reporterName: evil, item: { label: evil, categoryName: null }, amount: 1, date: "1.1.2027" }).subject,
    ];
    for (const s of subjects) {
      expect(s).not.toMatch(/[\r\n\t]/);
      expect(s.length).toBeLessThan(200);
    }
    expect(nb(subjects[0])).toContain("Flüge Bcc: x@y.z X");
  });
  it("keine Zeilenumbrüche in Push-Titeln", () => {
    const ps = [
      itemReminderPush({ tripName: "T", tripId: "t", itemLabel: evil, amount: 1, itemId: "i" }),
      itemAnnouncedPush({ tripName: "T", tripId: "t", isUpdate: true, itemLabel: evil, amount: 1, itemId: "i" }),
      itemPaymentPendingPush({ payerName: evil, itemLabel: evil, amount: 1, tripId: "t", itemId: "i", payerPersonId: "p" }),
      paymentPendingPush({ payerName: evil, amount: 1, tripId: "t", trancheId: "x", payerPersonId: "p", what: evil }),
      planAnnouncedPush({ tripName: "T", tripId: "t", isUpdate: false, amount: 1, what: evil }),
    ];
    for (const p of ps) expect(p.title).not.toMatch(/[\r\n\t]/);
  });
});
