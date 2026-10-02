// Benachrichtigungen für Reise-Posten und den Anzahlungsplan (PR6).
//
// Drei Ebenen:
//   1. Reine Regeln (lib/prepayments/notify.ts): Empfänger/Aktor-Ausschluss,
//      Wero-Regel, Crewfrist mit Puffer/Clamp/ohne Fälligkeit, Ergebnis-Text.
//   2. Templates: Wero mit/ohne ID (inkl. der bestehenden Erinnerungsmail),
//      Escaping frei editierbarer Texte, Reise-Typ „other".
//   3. Actions gegen den filternden In-Memory-Fake: wer bekommt WIRKLICH eine
//      Mail, einmaliger Versand „Anzahlungsplan angelegt", Knopf-Berechtigung,
//      Mailfehler kippt die Aktion nie, fehlende Migration 0062 → fail-soft.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue(new Map()) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/authz", () => ({
  requireMember: vi.fn(),
  requireSkipperOrAdmin: vi.fn(),
  requireSkipperAdminOrItemPayee: vi.fn(),
  requireSkipperAdminOrAdvancer: vi.fn(),
}));
vi.mock("@/lib/auth/get-current-person", () => ({ getCurrentPerson: vi.fn() }));
vi.mock("@/lib/email/send", () => ({
  sendMails: vi.fn(),
  sendMail: vi.fn(async () => ({ ok: true, id: "m" })),
}));
vi.mock("@/lib/notify/web-push", () => ({
  sendPushToPersons: vi.fn(async () => ({ sent: 0, failed: 0, removed: 0 })),
}));

import {
  announceRecipients,
  crewDueLabel,
  formatNotifiedAt,
  itemNoticeRecipients,
  normalizeWeroId,
  notifyResultMessage,
  trancheShares,
  allocateCoverage,
  weroIdForItem,
} from "@/lib/prepayments/notify";
import { renderWhatsAppText, DEFAULT_WHATSAPP_TEMPLATE } from "@/lib/prepayments/whatsapp";
import {
  renderItemAnnounceCrewMail,
  renderItemAnnouncePayeeMail,
  renderPlanAnnounceAdvancerMail,
  renderPlanAnnounceCrewMail,
} from "@/lib/email/announce-templates";
import { renderItemNoticeMail, renderItemPendingMail } from "@/lib/email/item-notice-template";
import { renderPrepaymentReminderMail } from "@/lib/email/prepayment-reminder-template";
import {
  saveItem,
  recordItemPayment,
  submitItemSelfPayment,
  confirmItemSelfPayment,
  rejectItemSelfPayment,
  recordItemProviderPayment,
} from "@/lib/actions/prepayment-items";
import { saveTranches } from "@/lib/actions/prepayments";
import { notifyItemCrew, notifyPlanCrew } from "@/lib/actions/prepayment-notify";
import { sendItemAnnouncement } from "@/lib/email/send-prepayment-notices";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { requireMember, requireSkipperOrAdmin, requireSkipperAdminOrItemPayee } from "@/lib/auth/authz";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendMails } from "@/lib/email/send";
import { sendPushToPersons } from "@/lib/notify/web-push";
import { createFakeSupabase, type Row } from "./helpers/fake-supabase";

const mockedPerson = vi.mocked(getCurrentPerson);
const mockedMember = vi.mocked(requireMember);
const mockedSkipper = vi.mocked(requireSkipperOrAdmin);
const mockedPayee = vi.mocked(requireSkipperAdminOrItemPayee);
const mockedAdmin = vi.mocked(createAdminClient);
const mockedSendMails = vi.mocked(sendMails);
const mockedPush = vi.mocked(sendPushToPersons);

const TRIP = "aaaaaaaa-0000-4000-8000-000000000001";
const SKIPPER = "aaaaaaaa-0000-4000-8000-000000000002";
const ANNA = "aaaaaaaa-0000-4000-8000-000000000003";
const BEN = "aaaaaaaa-0000-4000-8000-000000000004";
const CLARA = "aaaaaaaa-0000-4000-8000-000000000005"; // kein Soll
const ADMIN = "aaaaaaaa-0000-4000-8000-000000000007"; // globaler Admin, nicht Crew
const ITEM = "aaaaaaaa-0000-4000-8000-0000000000d1";
const NEW_ITEM = "aaaaaaaa-0000-4000-8000-0000000000d2";
const CAT = "aaaaaaaa-0000-4000-8000-0000000000c1";
const KEY1 = "aaaaaaaa-0000-4000-8000-0000000000e1";
const TX_PENDING = "aaaaaaaa-0000-4000-8000-0000000000f1";
const T1 = "aaaaaaaa-0000-4000-8000-000000000011";
const T2 = "aaaaaaaa-0000-4000-8000-000000000012";

const EMAIL: Record<string, string> = {
  [SKIPPER]: "skipper@example.test",
  [ANNA]: "anna@example.test",
  [BEN]: "ben@example.test",
  [CLARA]: "clara@example.test",
  [ADMIN]: "admin@example.test",
};

function tables(extra: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  return {
    trips: [
      {
        id: TRIP, name: "Ostsee <2027>", trip_type: "sailing", archived: false, skipper_id: SKIPPER,
        start_date: "2027-05-01", end_date: "2027-05-10",
      },
    ],
    trip_members: [SKIPPER, ANNA, BEN, CLARA].map((p) => ({ trip_id: TRIP, person_id: p, on_board_from: null, on_board_to: null })),
    persons: [
      { id: SKIPPER, display_name: "Jannik" },
      { id: ANNA, display_name: "Anna" },
      { id: BEN, display_name: "Ben" },
      { id: CLARA, display_name: "Clara" },
      { id: ADMIN, display_name: "Admin" },
    ],
    persons_private: Object.entries(EMAIL).map(([person_id, email]) => ({ person_id, email })),
    trip_categories: [{ id: CAT, trip_id: TRIP, name: "An-/Abreise", icon: "Plane" }],
    prepayment_items: [
      {
        id: ITEM, trip_id: TRIP, category_id: CAT, label: "Flüge", total_amount: 300, due_date: "2027-03-01",
        payee_person_id: SKIPPER, split_type: "individuell", sort_order: 0,
      },
    ],
    prepayment_item_obligations: [
      { item_id: ITEM, trip_id: TRIP, person_id: SKIPPER, amount: 50 },
      { item_id: ITEM, trip_id: TRIP, person_id: ANNA, amount: 100 },
      { item_id: ITEM, trip_id: TRIP, person_id: BEN, amount: 150 },
      { item_id: ITEM, trip_id: TRIP, person_id: CLARA, amount: 0 },
    ],
    prepayment_plan: [],
    prepayment_tranches: [],
    prepayment_obligations: [],
    transactions: [],
    transaction_participants: [],
    audit_log: [],
    push_subscriptions: [],
    ...extra,
  } as Record<string, Row[]>;
}

let fake: ReturnType<typeof createFakeSupabase>;
function setup(t: Record<string, Row[]>) {
  fake = createFakeSupabase(t);
  fake.onRpc("mark_post_settlement_change", () => ({ data: null }));
  fake.onRpc("move_item_payee", () => ({ data: 0 }));
  mockedAdmin.mockReturnValue(fake.client as never);
  return fake;
}

/** Alle Empfänger-Adressen aller sendMails-Aufrufe (flach). */
function mailedTo(): string[] {
  return mockedSendMails.mock.calls.flatMap((c) => c[0].map((m) => m.to)).sort();
}
/** fmtEuro trennt Betrag und € mit NBSP — für lesbare Assertions normalisieren. */
const norm = (s: string | undefined) => (s ?? "").replace(/\u00a0/g, " ");
function mails() {
  return mockedSendMails.mock.calls.flatMap((c) => c[0]).map((m) => ({ ...m, text: norm(m.text), html: norm(m.html) }));
}
function pushedTo(): string[] {
  return mockedPush.mock.calls.flatMap((c) => c[1] as string[]).sort();
}

const payloadFd = (p: Record<string, unknown>) => {
  const f = new FormData();
  f.set("payload", JSON.stringify(p));
  return f;
};
const fd = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) f.set(k, val);
  return f;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedSendMails.mockImplementation(async (msgs) => msgs.map(() => ({ ok: true as const, id: "m" })));
  mockedPerson.mockResolvedValue({ id: SKIPPER, display_name: "Jannik" } as never);
  mockedSkipper.mockResolvedValue({ ok: true, personId: SKIPPER });
  mockedMember.mockResolvedValue({ ok: true, personId: ANNA });
  mockedPayee.mockResolvedValue({ ok: true, personId: SKIPPER, tripId: TRIP, payeePersonId: SKIPPER });
});

// ═════════════════════════════════════════════════════════════════════════
// 1. Reine Regeln
// ═════════════════════════════════════════════════════════════════════════
describe("announceRecipients", () => {
  const soll = [
    { personId: SKIPPER, amount: 50 },
    { personId: ANNA, amount: 100 },
    { personId: BEN, amount: 150 },
    { personId: CLARA, amount: 0 },
  ];
  it("nimmt Aktor, Geld-Empfänger und Soll 0 aus; Empfänger = Aktor → keine Übersicht", () => {
    const r = announceRecipients({ soll, payeeId: SKIPPER, actorId: SKIPPER });
    expect(r.crew.map((c) => c.personId).sort()).toEqual([ANNA, BEN].sort());
    expect(r.payeeId).toBeNull();
  });
  it("Aktor ist Crew (nicht Empfänger): Aktor ausgenommen, Empfänger bekommt Übersicht", () => {
    const r = announceRecipients({ soll, payeeId: SKIPPER, actorId: ANNA });
    expect(r.crew.map((c) => c.personId)).toEqual([BEN]);
    expect(r.payeeId).toBe(SKIPPER);
  });
  it("Admin ohne Crew-Rolle: alle mit Soll außer Empfänger + Übersicht an Empfänger", () => {
    const r = announceRecipients({ soll, payeeId: SKIPPER, actorId: ADMIN });
    expect(r.crew.map((c) => c.personId).sort()).toEqual([ANNA, BEN].sort());
    expect(r.payeeId).toBe(SKIPPER);
  });
  it("dedupliziert doppelte Soll-Zeilen", () => {
    const r = announceRecipients({ soll: [...soll, { personId: ANNA, amount: 100 }], payeeId: SKIPPER, actorId: null });
    expect(r.crew.filter((c) => c.personId === ANNA)).toHaveLength(1);
  });
});

describe("itemNoticeRecipients", () => {
  it("Dritter erfasst: zahlende Person + Empfänger", () => {
    expect(itemNoticeRecipients({ actorId: ADMIN, payerId: ANNA, payeeId: SKIPPER })).toEqual([
      { personId: ANNA, role: "payer" },
      { personId: SKIPPER, role: "payee" },
    ]);
  });
  it("Empfänger handelt selbst: nur die zahlende Person", () => {
    expect(itemNoticeRecipients({ actorId: SKIPPER, payerId: ANNA, payeeId: SKIPPER })).toEqual([
      { personId: ANNA, role: "payer" },
    ]);
  });
  it("Selbstverrechnung des Empfängers durch sich selbst: niemand", () => {
    expect(itemNoticeRecipients({ actorId: SKIPPER, payerId: SKIPPER, payeeId: SKIPPER })).toEqual([]);
  });
  it("Selbstverrechnung, erfasst vom Admin: Empfänger nur EINMAL (als payer)", () => {
    expect(itemNoticeRecipients({ actorId: ADMIN, payerId: SKIPPER, payeeId: SKIPPER })).toEqual([
      { personId: SKIPPER, role: "payer" },
    ]);
  });
});

describe("Wero-Regel (Helfer)", () => {
  it("normalizeWeroId: leer/Whitespace/null → null, sonst getrimmt", () => {
    expect(normalizeWeroId("")).toBeNull();
    expect(normalizeWeroId("   ")).toBeNull();
    expect(normalizeWeroId(null)).toBeNull();
    expect(normalizeWeroId(" +49 170 ")).toBe("+49 170");
  });
  it("weroIdForItem: nur wenn die vorstreckende Person den Posten empfängt", () => {
    expect(weroIdForItem({ planWeroId: "W1", advancerId: SKIPPER, payeeId: SKIPPER })).toBe("W1");
    expect(weroIdForItem({ planWeroId: "W1", advancerId: ANNA, payeeId: SKIPPER })).toBeNull();
    expect(weroIdForItem({ planWeroId: "  ", advancerId: SKIPPER, payeeId: SKIPPER })).toBeNull();
    expect(weroIdForItem({ planWeroId: "W1", advancerId: null, payeeId: SKIPPER })).toBeNull();
  });
});

describe("crewDueLabel — 3 Tage Puffer, Clamp, ohne Fälligkeit", () => {
  it("zieht 3 Tage ab", () => {
    expect(crewDueLabel("2027-03-10", "2027-01-01")).toBe("7.3.2027");
  });
  it("clampt auf heute, solange die Frist beim Anbieter noch aussteht", () => {
    expect(crewDueLabel("2027-03-10", "2027-03-09")).toBe("9.3.2027");
  });
  it("liegt nie nach der Frist beim Anbieter", () => {
    expect(crewDueLabel("2027-03-10", "2027-03-20")).toBe("10.3.2027");
  });
  it("ohne Fälligkeit → null", () => {
    expect(crewDueLabel(null, "2027-01-01")).toBeNull();
  });
  it("trancheShares: Σ Raten = Gesamtanteil (kein Cent-Drift)", () => {
    expect(trancheShares(100.01, [50, 50])).toEqual([50.01, 50]);
    const r = trancheShares(333.33, [30, 30, 40]);
    expect(Math.round(r.reduce((a, b) => a + b, 0) * 100)).toBe(33333);
  });
});

describe("allocateCoverage — Überzahlung verrechnen, nie negativ", () => {
  it("Rate 2 überzahlt (60 von 50), Rate 1 unterzahlt (40) → Σ 100 gedeckt, nichts offen", () => {
    const cov = allocateCoverage([50, 50], 100, 0);
    expect(cov.map((c) => c.open)).toEqual([0, 0]);
  });
  it("bezahlte zuerst, dann gemeldete, früheste Rate zuerst", () => {
    expect(allocateCoverage([50, 50], 30, 40)).toEqual([
      { amount: 50, paid: 30, pending: 20, open: 0 },
      { amount: 50, paid: 0, pending: 20, open: 30 },
    ]);
  });
  it("Überschuss über alle Raten → offen 0, nicht negativ", () => {
    expect(allocateCoverage([50], 80, 10)).toEqual([{ amount: 50, paid: 50, pending: 0, open: 0 }]);
  });
});

describe("WhatsApp-Text — Wero-Regel", () => {
  const base = { name: "Anna", trancheLabel: "Endzahlung", tripName: "Ostsee", amount: 100, dueDate: "2027-04-10" };
  it("mit Wero-ID → Zeile mit ID", () => {
    expect(renderWhatsAppText({ ...base, weroId: "W-1" })).toMatch(/Wero:\s+W-1/);
  });
  it("ohne / Whitespace → keine Wero-Zeile im Default", () => {
    for (const weroId of [null, "", "   "]) {
      const t = renderWhatsAppText({ ...base, weroId, weroLink: "  " });
      expect(t.toLowerCase()).not.toContain("wero");
      expect(t).toContain("Verwendungszweck: Anzahlung Ostsee Endzahlung");
    }
    expect(DEFAULT_WHATSAPP_TEMPLATE).toContain("Wero:");
  });
  it("eigene Vorlage: Platzhalter mitten im Satz wird leer ersetzt", () => {
    const t = renderWhatsAppText({ ...base, template: "Zahl an {{wero_link_or_id}} bitte, {{name}}", weroId: " " });
    expect(t).toBe("Zahl an  bitte, Anna");
  });
});

describe("notifyResultMessage / formatNotifiedAt", () => {
  it("meldet Teilfehler und fehlende Adressen", () => {
    expect(notifyResultMessage({ sent: 3, failed: 1, skipped: 2 })).toEqual({
      message: "3 Mails verschickt (1 Mail nicht zugestellt, 2 ohne E-Mail-Adresse).",
      variant: "error",
    });
    expect(notifyResultMessage({ sent: 1, failed: 0, skipped: 0 }).variant).toBe("success");
    expect(notifyResultMessage({ sent: 0, failed: 0, skipped: 0 }).variant).toBe("info");
    expect(notifyResultMessage({ sent: 0, failed: 2, skipped: 0 }).variant).toBe("error");
  });
  it("formatiert in Europe/Berlin (deterministisch)", () => {
    expect(formatNotifiedAt("2027-01-15T12:05:00Z")).toBe("15.1.2027, 13:05");
    expect(formatNotifiedAt(null)).toBeNull();
    expect(formatNotifiedAt("kaputt")).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 2. Templates
// ═════════════════════════════════════════════════════════════════════════
const item = { label: "Flüge <b>", categoryName: "An-/Abreise" };

describe("Wero-Regel in den Mails", () => {
  const crewItem = (weroId: string | null) =>
    renderItemAnnounceCrewMail({
      isUpdate: false, recipientName: "Anna", payeeName: "Jannik", tripName: "Ostsee", tripType: "sailing",
      item, amount: 100, crewDue: "7.3.2027", weroId, appUrl: "https://x.test/p",
    });
  const crewPlan = (weroId: string | null) =>
    renderPlanAnnounceCrewMail({
      isUpdate: false, recipientName: "Anna", advancerName: "Jannik", tripName: "Ostsee", tripType: "sailing",
      total: 500, tranches: [{ label: "1. Anzahlung", amount: 250, crewDue: "1.2.2027" }], weroId, appUrl: "https://x.test/p",
    });
  const reminder = (weroId: string | null) =>
    renderPrepaymentReminderMail({
      recipientName: "Anna", tripName: "Ostsee", advancerName: "Jannik", appUrl: "https://x.test/p", tripType: "sailing",
      tranches: [{ label: "Endzahlung", due_date: "1.2.2027", amount_due: 100, amount_total: 100 }], weroId,
    });

  for (const [name, render] of [["Posten angelegt", crewItem], ["Plan angelegt", crewPlan], ["Erinnerung (bestehend)", reminder]] as const) {
    it(`${name}: mit Wero-ID → Wero-Block mit ID`, () => {
      const m = render("WERO-123");
      expect(m.html).toContain("WERO-123");
      expect(m.html).toContain("Wero");
      expect(m.text).toContain("WERO-123");
    });
    it(`${name}: ohne / nur Whitespace → Wero kommt nicht vor`, () => {
      for (const id of [null, "   "]) {
        const m = render(id);
        expect(m.html.toLowerCase()).not.toContain("wero");
        expect(m.text.toLowerCase()).not.toContain("wero");
      }
    });
  }

  it("Plan-Mail: Verwendungszweck auch ohne Wero (neutral)", () => {
    expect(norm(crewPlan(null).text)).toContain("Verwendungszweck: Anzahlung Ostsee");
  });
});

describe("Escaping frei editierbarer Texte", () => {
  const evil = `<img src=x onerror=alert(1)>`;
  it("Posten-Crew-Mail escaped Label, Kategorie, Namen, Törn, Wero-ID", () => {
    const m = renderItemAnnounceCrewMail({
      isUpdate: true, recipientName: evil, payeeName: evil, tripName: evil, tripType: "sailing",
      item: { label: evil, categoryName: evil }, amount: 1, crewDue: null, weroId: evil, appUrl: "https://x.test",
    });
    expect(m.html).not.toContain("<img src=x");
    expect(m.html).toContain("&lt;img");
  });
  it("Empfänger-Übersicht, Plan-Mails, Notice und Pending escapen", () => {
    const htmls = [
      renderItemAnnouncePayeeMail({
        isUpdate: false, recipientName: evil, tripName: evil, tripType: "sailing", item: { label: evil, categoryName: evil },
        total: 10, providerDue: null, rows: [{ name: evil, amount: 5 }], ownAmount: 5, appUrl: "https://x.test",
      }).html,
      renderPlanAnnounceAdvancerMail({
        isUpdate: false, recipientName: evil, tripName: evil, tripType: "sailing", providerTotal: 10,
        tranches: [{ label: evil, charterDue: "1.1.2027", toProvider: 10, fromCrew: 5 }], rows: [{ name: evil, amount: 5 }],
        ownAmount: 5, appUrl: "https://x.test",
      }).html,
      renderPlanAnnounceCrewMail({
        isUpdate: false, recipientName: evil, advancerName: evil, tripName: evil, tripType: "sailing", total: 1,
        tranches: [{ label: evil, amount: 1, crewDue: evil }], weroId: null, appUrl: "https://x.test",
      }).html,
      renderItemNoticeMail({
        kind: "item_payment_rejected", role: "payee", recipientName: evil, actorName: evil, payerName: evil, payeeName: evil,
        tripName: evil, tripType: "sailing", item: { label: evil, categoryName: evil }, amount: 1, appUrl: "https://x.test",
      }).html,
      renderItemPendingMail({
        recipientName: evil, reporterName: evil, tripName: evil, tripType: "sailing", item: { label: evil, categoryName: evil },
        amount: 1, date: "1.1.2027", note: evil, appUrl: "https://x.test",
      }).html,
    ];
    for (const h of htmls) {
      expect(h).not.toContain("<img src=x");
      expect(h).toContain("&lt;img");
    }
  });
});

describe("Frist in der Posten-Mail", () => {
  it("mit Crewfrist → Datum, ohne → „Frist folgt“", () => {
    const base = {
      isUpdate: false, recipientName: "Anna", payeeName: "Jannik", tripName: "Ostsee", tripType: "sailing" as const,
      item, amount: 100, weroId: null, appUrl: "https://x.test",
    };
    expect(renderItemAnnounceCrewMail({ ...base, crewDue: "7.3.2027" }).text).toContain("Bitte zahlen bis: 7.3.2027");
    const none = renderItemAnnounceCrewMail({ ...base, crewDue: null });
    expect(none.text).toContain("sie folgt");
    expect(none.text).not.toContain("Bitte zahlen bis");
  });
});

describe("Reise-Typ „other“", () => {
  it("nutzt Urlaubskasse/Reise statt Bordkasse/Törn im Inhalt", () => {
    const m = renderPlanAnnounceCrewMail({
      isUpdate: false, recipientName: "Anna", advancerName: "Jannik", tripName: "Rom", tripType: "other", total: 100,
      tranches: [{ label: "Endzahlung", amount: 100, crewDue: "1.2.2027" }], weroId: null, appUrl: "https://x.test",
    });
    expect(norm(m.text)).toContain("Urlaubsanzahlung");
    expect(m.text).toContain("die Reise");
    expect(m.text).not.toContain("den Törn");
    expect(m.html).toContain("In der Urlaubskasse ansehen");
    const it2 = renderItemAnnounceCrewMail({
      isUpdate: false, recipientName: "Anna", payeeName: "Jannik", tripName: "Rom", tripType: "other",
      item, amount: 100, crewDue: null, weroId: null, appUrl: "https://x.test",
    });
    expect(it2.html).toContain("In der Urlaubskasse ansehen");
    expect(it2.text).toContain("die Reise");
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 3. Actions
// ═════════════════════════════════════════════════════════════════════════
describe("saveItem — Mail „Posten angelegt“", () => {
  const createPayload = {
    trip_id: TRIP, id: NEW_ITEM, category_id: CAT, label: "Bahn", total_amount: "90", split_type: "individuell",
    due_date: "2027-03-10",
    obligations: [
      { person_id: SKIPPER, amount: "30" },
      { person_id: ANNA, amount: "30" },
      { person_id: BEN, amount: "30" },
      { person_id: CLARA, amount: "0" },
    ],
  };

  it("an alle mit Soll außer Aktor/Empfänger (Skipper ist beides)", async () => {
    setup(tables());
    const res = await saveItem({ status: "idle" }, payloadFd(createPayload));
    expect(res).toEqual({ status: "ok", itemId: NEW_ITEM });
    expect(mailedTo()).toEqual([EMAIL[ANNA], EMAIL[BEN]].sort());
    expect(pushedTo()).toEqual([ANNA, BEN].sort());
    expect(pushedTo()).not.toContain(SKIPPER);
    expect(mails()[0].subject).toContain("Neuer Posten: Bahn");
    // Push additiv NACH der Mail.
    expect(mockedSendMails.mock.invocationCallOrder[0]).toBeLessThan(mockedPush.mock.invocationCallOrder[0]);
    // „zuletzt informiert" gesetzt.
    expect(fake.rows("prepayment_items").find((i) => i.id === NEW_ITEM)!.crew_last_notified_at).toBeTruthy();
  });

  it("Admin legt an: Empfänger bekommt die Übersicht, Admin nichts", async () => {
    setup(tables());
    mockedPerson.mockResolvedValue({ id: ADMIN, display_name: "Admin" } as never);
    await saveItem({ status: "idle" }, payloadFd(createPayload));
    expect(mailedTo()).toEqual([EMAIL[ANNA], EMAIL[BEN], EMAIL[SKIPPER]].sort());
    const payeeMail = mails().find((m) => m.to === EMAIL[SKIPPER])!;
    expect(payeeMail.subject).toContain("Übersicht für dich");
    expect(payeeMail.text).toContain("Anna: 30,00 €");
    expect(mailedTo()).not.toContain(EMAIL[ADMIN]);
  });

  it("Retry mit derselben ID (Update-Pfad) und spätere Änderung verschicken nichts", async () => {
    setup(tables());
    await saveItem({ status: "idle" }, payloadFd(createPayload));
    mockedSendMails.mockClear();
    mockedPush.mockClear();
    const again = await saveItem({ status: "idle" }, payloadFd(createPayload));
    expect(again.status).toBe("ok");
    const changed = await saveItem({ status: "idle" }, payloadFd({ ...createPayload, label: "Bahn neu", due_date: "2027-03-20" }));
    expect(changed.status).toBe("ok");
    expect(mockedSendMails).not.toHaveBeenCalled();
    expect(mockedPush).not.toHaveBeenCalled();
  });

  it("Mailversand wirft → Posten trotzdem gespeichert, Ergebnis ok", async () => {
    setup(tables());
    mockedSendMails.mockRejectedValue(new Error("SMTP down"));
    const res = await saveItem({ status: "idle" }, payloadFd(createPayload));
    expect(res).toEqual({ status: "ok", itemId: NEW_ITEM });
    expect(fake.rows("prepayment_items").some((i) => i.id === NEW_ITEM)).toBe(true);
  });

  it("Mails scheitern (ok:false) → Ergebnis ok, kein „zuletzt informiert“", async () => {
    setup(tables());
    mockedSendMails.mockImplementation(async (msgs) => msgs.map(() => ({ ok: false as const, error: "x" })));
    const res = await saveItem({ status: "idle" }, payloadFd(createPayload));
    expect(res.status).toBe("ok");
    expect(fake.rows("prepayment_items").find((i) => i.id === NEW_ITEM)!.crew_last_notified_at).toBeFalsy();
  });

  it("Personen-Abfrage scheitert → Ergebnis ok, keine Mail", async () => {
    setup(tables());
    fake.failOn({ table: "persons_private", action: "select" });
    const res = await saveItem({ status: "idle" }, payloadFd(createPayload));
    expect(res.status).toBe("ok");
    expect(mockedSendMails).not.toHaveBeenCalled();
  });

  it("Wero-ID des Plans nur, wenn die vorstreckende Person den Posten empfängt", async () => {
    setup(tables({ prepayment_plan: [{ trip_id: TRIP, advancer_person_id: SKIPPER, wero_id: "WERO-9", total_amount: 100 }] }));
    await saveItem({ status: "idle" }, payloadFd(createPayload));
    expect(mails().every((m) => m.text!.includes("WERO-9"))).toBe(true);

    vi.clearAllMocks();
    mockedSendMails.mockImplementation(async (msgs) => msgs.map(() => ({ ok: true as const, id: "m" })));
    mockedPerson.mockResolvedValue({ id: SKIPPER, display_name: "Jannik" } as never);
    mockedSkipper.mockResolvedValue({ ok: true, personId: SKIPPER });
    setup(tables({ prepayment_plan: [{ trip_id: TRIP, advancer_person_id: ANNA, wero_id: "WERO-9", total_amount: 100 }] }));
    await saveItem({ status: "idle" }, payloadFd(createPayload));
    expect(mails().length).toBeGreaterThan(0);
    for (const m of mails()) expect(m.text!.toLowerCase()).not.toContain("wero");
  });
});

describe("Posten-Zahlungen — Benachrichtigungen", () => {
  it("Selbstmeldung → Mail + Push an den Empfänger, nicht an die meldende Person", async () => {
    setup(tables());
    mockedPerson.mockResolvedValue({ id: ANNA, display_name: "Anna" } as never);
    const res = await submitItemSelfPayment({ status: "idle" }, fd({
      trip_id: TRIP, item_id: ITEM, amount: "100", date: "2027-02-01", idempotency_key: KEY1,
    }));
    expect(res.status).toBe("ok");
    expect(mailedTo()).toEqual([EMAIL[SKIPPER]]);
    expect(mails()[0].subject).toContain("Zahlung gemeldet: Anna");
    expect(pushedTo()).toEqual([SKIPPER]);
  });

  it("Empfänger ohne E-Mail (Ghost) → Skipper wird stellvertretend informiert", async () => {
    const t = tables({ trip_members: [] });
    t.prepayment_items[0].payee_person_id = BEN;
    t.trip_members = [SKIPPER, ANNA, BEN, CLARA].map((p) => ({
      trip_id: TRIP, person_id: p, on_board_from: null, on_board_to: null, is_skipper: p === SKIPPER,
    }));
    t.persons_private = t.persons_private.filter((r) => r.person_id !== BEN);
    setup(t);
    mockedPerson.mockResolvedValue({ id: ANNA, display_name: "Anna" } as never);
    const res = await submitItemSelfPayment({ status: "idle" }, fd({
      trip_id: TRIP, item_id: ITEM, amount: "100", date: "2027-02-01", idempotency_key: KEY1,
    }));
    expect(res.status).toBe("ok");
    expect(mailedTo()).toEqual([EMAIL[SKIPPER]]);
    expect(mails()[0].text).toContain("an Ben gezahlt");
    expect(mails()[0].text).toContain("stellvertretend");
  });

  it("Selbstmeldung durch den Empfänger selbst → keine Mail", async () => {
    setup(tables());
    mockedMember.mockResolvedValue({ ok: true, personId: SKIPPER });
    const res = await submitItemSelfPayment({ status: "idle" }, fd({
      trip_id: TRIP, item_id: ITEM, amount: "50", date: "2027-02-01", idempotency_key: KEY1,
    }));
    expect(res.status).toBe("ok");
    expect(mockedSendMails).not.toHaveBeenCalled();
    expect(pushedTo()).toEqual([]);
  });

  it("Duplikat-Retry der Selbstmeldung verschickt nichts erneut", async () => {
    setup(tables());
    const f = { trip_id: TRIP, item_id: ITEM, amount: "100", date: "2027-02-01", idempotency_key: KEY1 };
    await submitItemSelfPayment({ status: "idle" }, fd(f));
    mockedSendMails.mockClear();
    const dup = await submitItemSelfPayment({ status: "idle" }, fd(f));
    expect(dup).toMatchObject({ status: "ok", duplicate: true });
    expect(mockedSendMails).not.toHaveBeenCalled();
  });

  const pendingTx = {
    id: TX_PENDING, trip_id: TRIP, type: "credit", item_id: ITEM, amount: 100, credit_from: ANNA, credit_to: SKIPPER,
    confirmed_at: null, deleted_at: null, date: "2027-02-01",
  };

  it("Bestätigung durch den Empfänger → nur die zahlende Person", async () => {
    setup(tables({ transactions: [{ ...pendingTx }] }));
    const res = await confirmItemSelfPayment({ status: "idle" }, fd({ transaction_id: TX_PENDING }));
    expect(res.status).toBe("ok");
    expect(mailedTo()).toEqual([EMAIL[ANNA]]);
    expect(mails()[0].subject).toContain("Zahlung bestätigt");
    expect(pushedTo()).toEqual([ANNA]);
  });

  it("Ablehnung durch einen Admin (Dritter) → zahlende Person + Empfänger", async () => {
    setup(tables({ transactions: [{ ...pendingTx }] }));
    mockedPerson.mockResolvedValue({ id: ADMIN, display_name: "Admin" } as never);
    mockedPayee.mockResolvedValue({ ok: true, personId: ADMIN, tripId: TRIP, payeePersonId: SKIPPER });
    const res = await rejectItemSelfPayment({ status: "idle" }, fd({ transaction_id: TX_PENDING }));
    expect(res.status).toBe("ok");
    expect(mailedTo()).toEqual([EMAIL[ANNA], EMAIL[SKIPPER]].sort());
    expect(mails().every((m) => m.subject.includes("abgelehnt"))).toBe(true);
    expect(pushedTo()).toEqual([ANNA, SKIPPER].sort());
  });

  it("Erfassung durch den Empfänger für Anna → nur Anna; durch Admin → Anna + Empfänger", async () => {
    setup(tables());
    await recordItemPayment({ status: "idle" }, fd({
      trip_id: TRIP, item_id: ITEM, person_id: ANNA, amount: "100", date: "2027-02-01", idempotency_key: KEY1,
    }));
    expect(mailedTo()).toEqual([EMAIL[ANNA]]);

    vi.clearAllMocks();
    mockedSendMails.mockImplementation(async (msgs) => msgs.map(() => ({ ok: true as const, id: "m" })));
    setup(tables());
    mockedPerson.mockResolvedValue({ id: ADMIN, display_name: "Admin" } as never);
    mockedPayee.mockResolvedValue({ ok: true, personId: ADMIN, tripId: TRIP, payeePersonId: SKIPPER });
    await recordItemPayment({ status: "idle" }, fd({
      trip_id: TRIP, item_id: ITEM, person_id: BEN, amount: "150", date: "2027-02-01", idempotency_key: KEY1,
    }));
    expect(mailedTo()).toEqual([EMAIL[BEN], EMAIL[SKIPPER]].sort());
  });

  it("Selbstverrechnung des Empfängers → keine Mail", async () => {
    setup(tables());
    const res = await recordItemPayment({ status: "idle" }, fd({
      trip_id: TRIP, item_id: ITEM, person_id: SKIPPER, amount: "50", date: "2027-02-01", idempotency_key: KEY1,
    }));
    expect(res.status).toBe("ok");
    expect(mockedSendMails).not.toHaveBeenCalled();
  });

  it("Anbieter-Zahlung → keine Mail", async () => {
    setup(tables());
    const res = await recordItemProviderPayment({ status: "idle" }, fd({
      trip_id: TRIP, item_id: ITEM, amount: "300", date: "2027-02-01", idempotency_key: KEY1,
    }));
    expect(res.status).toBe("ok");
    expect(mockedSendMails).not.toHaveBeenCalled();
  });

  it("Mailfehler bei Bestätigung kippt die Bestätigung nicht", async () => {
    setup(tables({ transactions: [{ ...pendingTx }] }));
    mockedSendMails.mockRejectedValue(new Error("SMTP down"));
    const res = await confirmItemSelfPayment({ status: "idle" }, fd({ transaction_id: TX_PENDING }));
    expect(res.status).toBe("ok");
    expect(fake.rows("transactions").find((t) => t.id === TX_PENDING)!.confirmed_at).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────
function planTables(extra: Partial<Record<string, Row[]>> = {}) {
  return tables({
    prepayment_plan: [{ trip_id: TRIP, advancer_person_id: null, wero_id: "", total_amount: 1000, crew_notified_at: null }],
    prepayment_obligations: [
      { trip_id: TRIP, person_id: SKIPPER, total_amount: 250 },
      { trip_id: TRIP, person_id: ANNA, total_amount: 250 },
      { trip_id: TRIP, person_id: BEN, total_amount: 500 },
      { trip_id: TRIP, person_id: CLARA, total_amount: 0 },
    ],
    ...extra,
  });
}
const tranchePayload = {
  trip_id: TRIP,
  tranches: [
    { id: T1, due_date: "2027-01-10", label: "1. Anzahlung", percent: 40, sort_order: 0 },
    { id: T2, due_date: "2027-04-10", label: "Endzahlung", percent: 60, sort_order: 1 },
  ],
};

describe("saveTranches — „Anzahlungsplan angelegt“ genau einmal", () => {
  it("erstes Fertigstellen: Crew mit Soll (ohne Vorstrecker/Aktor) bekommt Raten + Crewfrist", async () => {
    setup(planTables());
    const res = await saveTranches({ status: "idle" }, payloadFd(tranchePayload));
    expect(res.status).toBe("ok");
    expect(mailedTo()).toEqual([EMAIL[ANNA], EMAIL[BEN]].sort());
    const ben = mails().find((m) => m.to === EMAIL[BEN])!;
    expect(ben.text).toContain("Dein Anteil gesamt: 500,00 €");
    expect(ben.text).toContain("1. Anzahlung bis 7.1.2027: 200,00 €");
    expect(ben.text).toContain("Endzahlung bis 7.4.2027: 300,00 €");
    // leere Wero-ID → kein Wort über Wero
    expect(ben.text.toLowerCase()).not.toContain("wero");
    expect(fake.rows("prepayment_plan")[0].crew_notified_at).toBeTruthy();
    expect(fake.rows("prepayment_plan")[0].crew_last_notified_at).toBeTruthy();
  });

  it("zweites Speichern (Retry/Änderung) verschickt nichts mehr", async () => {
    setup(planTables());
    await saveTranches({ status: "idle" }, payloadFd(tranchePayload));
    mockedSendMails.mockClear();
    mockedPush.mockClear();
    const again = await saveTranches({ status: "idle" }, payloadFd(tranchePayload));
    expect(again.status).toBe("ok");
    expect(mockedSendMails).not.toHaveBeenCalled();
    expect(mockedPush).not.toHaveBeenCalled();
  });

  it("schon informierter Plan (Backfill 0062) → keine Mail", async () => {
    setup(planTables({
      prepayment_plan: [{ trip_id: TRIP, advancer_person_id: null, wero_id: "", total_amount: 1000, crew_notified_at: "2026-01-01T00:00:00Z" }],
    }));
    await saveTranches({ status: "idle" }, payloadFd(tranchePayload));
    expect(mockedSendMails).not.toHaveBeenCalled();
  });

  it("Admin stellt fertig, Anna streckt vor: Anna bekommt die Übersicht, Admin nichts", async () => {
    setup(planTables({
      prepayment_plan: [{ trip_id: TRIP, advancer_person_id: ANNA, wero_id: " W-1 ", total_amount: 1000, crew_notified_at: null }],
    }));
    mockedPerson.mockResolvedValue({ id: ADMIN, display_name: "Admin" } as never);
    await saveTranches({ status: "idle" }, payloadFd(tranchePayload));
    expect(mailedTo()).toEqual([EMAIL[ANNA], EMAIL[BEN], EMAIL[SKIPPER]].sort());
    const anna = mails().find((m) => m.to === EMAIL[ANNA])!;
    expect(anna.subject).toContain("Übersicht für dich");
    expect(anna.text).toContain("Summe an den Vercharterer: 1.000,00 €");
    const ben = mails().find((m) => m.to === EMAIL[BEN])!;
    expect(ben.text).toContain("Wero-ID (Anna): W-1");
  });

  it("Migration 0062 fehlt (Claim scheitert) → Tranchen gespeichert, KEINE Mail", async () => {
    setup(planTables());
    fake.failOn({ table: "prepayment_plan", action: "update", error: { message: 'column "crew_notified_at" does not exist' } });
    const res = await saveTranches({ status: "idle" }, payloadFd(tranchePayload));
    expect(res.status).toBe("ok");
    expect(fake.rows("prepayment_tranches")).toHaveLength(2);
    expect(mockedSendMails).not.toHaveBeenCalled();
  });

  it("scheitern alle Tranchen-Writes, wird das Einmal-Flag NICHT verbraucht", async () => {
    setup(planTables());
    fake.failOn({ table: "prepayment_tranches", action: "insert", nth: 1 });
    fake.failOn({ table: "prepayment_tranches", action: "insert", nth: 2 });
    await saveTranches({ status: "idle" }, payloadFd(tranchePayload));
    expect(fake.rows("prepayment_plan")[0].crew_notified_at).toBeFalsy();
    expect(mockedSendMails).not.toHaveBeenCalled();
  });

  it("nur EINE von zwei Tranchen gespeichert (Σ % ≠ 100) → keine unvollständige Mail, Flag bleibt frei", async () => {
    setup(planTables());
    fake.failOn({ table: "prepayment_tranches", action: "insert", nth: 2 });
    await saveTranches({ status: "idle" }, payloadFd(tranchePayload));
    expect(fake.rows("prepayment_tranches")).toHaveLength(1);
    expect(fake.rows("prepayment_plan")[0].crew_notified_at).toBeFalsy();
    expect(mockedSendMails).not.toHaveBeenCalled();
  });

  it("Plan hatte schon Tranchen, Flag aber NULL (Deploy-Fenster) → keine „angelegt“-Mail", async () => {
    setup(planTables({
      prepayment_tranches: [{ id: T1, trip_id: TRIP, label: "Endzahlung", due_date: "2027-04-10", percent: 100, sort_order: 0 }],
    }));
    await saveTranches({ status: "idle" }, payloadFd(tranchePayload));
    expect(mockedSendMails).not.toHaveBeenCalled();
    expect(fake.rows("prepayment_plan")[0].crew_notified_at).toBeFalsy();
  });

  it("Lesefehler der bestehenden Tranchen → Abbruch, nichts geschrieben, keine Mail", async () => {
    setup(planTables());
    fake.failOn({ table: "prepayment_tranches", action: "select", nth: 1 });
    const res = await saveTranches({ status: "idle" }, payloadFd(tranchePayload));
    expect(res.status).toBe("error");
    expect(fake.rows("prepayment_tranches")).toHaveLength(0);
    expect(mockedSendMails).not.toHaveBeenCalled();
  });

  it("Mailversand wirft → saveTranches trotzdem ok", async () => {
    setup(planTables());
    mockedSendMails.mockRejectedValue(new Error("SMTP down"));
    const res = await saveTranches({ status: "idle" }, payloadFd(tranchePayload));
    expect(res.status).toBe("ok");
  });
});

describe("Versand-Helfer werfen nie", () => {
  it("sendItemAnnouncement: sendMails wirft → Zählung statt Exception", async () => {
    setup(tables());
    mockedSendMails.mockRejectedValue(new Error("SMTP down"));
    const r = await sendItemAnnouncement(fake.client as never, { tripId: TRIP, itemId: ITEM, actorId: SKIPPER, isUpdate: true });
    expect(r).toEqual({ sent: 0, failed: 2, skipped: 0 });
    // Push trotzdem additiv versucht.
    expect(pushedTo()).toEqual([ANNA, BEN].sort());
  });
});

describe("Knopf „Crew informieren“", () => {
  it("Plan: nur Skipper/Admin — sonst Fehler und keine Mail", async () => {
    setup(planTables({ prepayment_tranches: [{ id: T1, trip_id: TRIP, label: "Endzahlung", due_date: "2027-04-10", percent: 100, sort_order: 0 }] }));
    mockedSkipper.mockResolvedValue({ ok: false, message: "Nur Skipper." });
    const res = await notifyPlanCrew(TRIP);
    expect(res).toEqual({ status: "error", message: "Nur Skipper." });
    expect(mockedSendMails).not.toHaveBeenCalled();
  });

  it("Plan: verschickt die Update-Variante und meldet sent/failed/skipped", async () => {
    setup(planTables({
      prepayment_tranches: [{ id: T1, trip_id: TRIP, label: "Endzahlung", due_date: "2027-04-10", percent: 100, sort_order: 0 }],
      persons_private: [{ person_id: ANNA, email: EMAIL[ANNA] }], // Ben ohne Adresse
    }));
    const res = await notifyPlanCrew(TRIP);
    expect(res).toEqual({ status: "ok", sent: 1, failed: 0, skipped: 1 });
    expect(mails()[0].subject).toContain("Plan geändert");
    // Ben bekommt trotzdem den Push (Push hängt nicht an der Mail-Adresse).
    expect(pushedTo()).toEqual([ANNA, BEN].sort());
    expect(fake.rows("prepayment_plan")[0].crew_last_notified_at).toBeTruthy();
  });

  it("Plan: archivierter Törn → Fehler, keine Mail", async () => {
    const t = planTables({ prepayment_tranches: [{ id: T1, trip_id: TRIP, label: "Endzahlung", due_date: "2027-04-10", percent: 100, sort_order: 0 }] });
    t.trips[0].archived = true;
    setup(t);
    const res = await notifyPlanCrew(TRIP);
    expect(res.status).toBe("error");
    expect(mockedSendMails).not.toHaveBeenCalled();
  });

  it("Posten-Update fordert niemanden auf, Bezahltes erneut zu zahlen", async () => {
    setup(tables({
      prepayment_plan: [{ trip_id: TRIP, advancer_person_id: SKIPPER, wero_id: "WERO-9", total_amount: 100 }],
      v_prepayment_item_payments: [
        { trip_id: TRIP, item_id: ITEM, person_id: ANNA, paid_amount: 100 },
        { trip_id: TRIP, item_id: ITEM, person_id: BEN, paid_amount: 50 },
      ],
    }));
    await notifyItemCrew(TRIP, ITEM);
    const anna = mails().find((m) => m.to === EMAIL[ANNA])!;
    expect(anna.text).toContain("bereits vollständig bezahlt");
    expect(anna.text.toLowerCase()).not.toContain("wero");
    expect(anna.text).not.toContain("Bitte zahlen bis");
    const ben = mails().find((m) => m.to === EMAIL[BEN])!;
    expect(ben.text).toContain("Noch offen:  100,00 €");
    expect(ben.text).toContain("WERO-9");
  });

  it("Plan-Update: bezahlte Rate markiert, offene Summe, ohne Zahlungsblock wenn alles bezahlt", async () => {
    setup(planTables({
      prepayment_plan: [{ trip_id: TRIP, advancer_person_id: null, wero_id: "W-1", total_amount: 1000, crew_notified_at: "2026-01-01T00:00:00Z" }],
      prepayment_tranches: [
        { id: T1, trip_id: TRIP, label: "1. Anzahlung", due_date: "2027-01-10", percent: 40, sort_order: 0 },
        { id: T2, trip_id: TRIP, label: "Endzahlung", due_date: "2027-04-10", percent: 60, sort_order: 1 },
      ],
      v_prepayment_payments: [
        { trip_id: TRIP, tranche_id: T1, person_id: ANNA, paid_amount: 100 },
        { trip_id: TRIP, tranche_id: T2, person_id: ANNA, paid_amount: 150 },
        { trip_id: TRIP, tranche_id: T1, person_id: BEN, paid_amount: 200 },
      ],
    }));
    await notifyPlanCrew(TRIP);
    const anna = mails().find((m) => m.to === EMAIL[ANNA])!;
    expect(anna.text).toContain("bereits vollständig bezahlt");
    expect(anna.text.toLowerCase()).not.toContain("wero");
    const ben = mails().find((m) => m.to === EMAIL[BEN])!;
    expect(ben.text).toContain("1. Anzahlung bis 7.1.2027: 200,00 € (bezahlt)");
    expect(ben.text).toContain("Noch offen: 300,00 €");
    expect(ben.text).toContain("W-1");
  });

  it("Posten-Update: offene Selbstmeldung → „wartet auf Bestätigung“ statt Aufforderung", async () => {
    setup(tables({
      prepayment_plan: [{ trip_id: TRIP, advancer_person_id: SKIPPER, wero_id: "WERO-9", total_amount: 100 }],
      v_prepayment_item_pending: [{ trip_id: TRIP, item_id: ITEM, person_id: ANNA, amount: 100 }],
    }));
    await notifyItemCrew(TRIP, ITEM);
    const anna = mails().find((m) => m.to === EMAIL[ANNA])!;
    expect(anna.text).toContain("wartet auf die Bestätigung durch Jannik");
    expect(anna.text).not.toContain("Bitte zahlen bis");
    expect(anna.text.toLowerCase()).not.toContain("wero");
  });

  it("Selbstmeldungen nicht lesbar → fail-closed, keine Update-Mail", async () => {
    setup(tables());
    fake.failOn({ table: "v_prepayment_item_pending", action: "select" });
    expect((await notifyItemCrew(TRIP, ITEM)).status).toBe("error");
    expect(mockedSendMails).not.toHaveBeenCalled();
  });

  it("Plan-Update: Überzahlung einer Rate deckt die andere, Selbstmeldung zählt als gemeldet", async () => {
    setup(planTables({
      prepayment_plan: [{ trip_id: TRIP, advancer_person_id: null, wero_id: "W-1", total_amount: 1000, crew_notified_at: "2026-01-01T00:00:00Z" }],
      prepayment_obligations: [
        { trip_id: TRIP, person_id: SKIPPER, total_amount: 0 },
        { trip_id: TRIP, person_id: ANNA, total_amount: 100 },
        { trip_id: TRIP, person_id: BEN, total_amount: 100 },
      ],
      prepayment_tranches: [
        { id: T1, trip_id: TRIP, label: "1. Anzahlung", due_date: "2027-01-10", percent: 50, sort_order: 0 },
        { id: T2, trip_id: TRIP, label: "Endzahlung", due_date: "2027-04-10", percent: 50, sort_order: 1 },
      ],
      v_prepayment_payments: [
        { trip_id: TRIP, tranche_id: T2, person_id: ANNA, paid_amount: 60 },
        { trip_id: TRIP, tranche_id: T1, person_id: ANNA, paid_amount: 40 },
      ],
      v_prepayment_pending: [{ trip_id: TRIP, tranche_id: T1, person_id: BEN, amount: 100 }],
    }));
    await notifyPlanCrew(TRIP);
    const anna = mails().find((m) => m.to === EMAIL[ANNA])!;
    expect(anna.text).toContain("bereits vollständig bezahlt");
    expect(anna.text.toLowerCase()).not.toContain("wero");
    const ben = mails().find((m) => m.to === EMAIL[BEN])!;
    expect(ben.text).toContain("wartet auf die Bestätigung");
    expect(ben.text.toLowerCase()).not.toContain("wero");
  });

  it("Plan: Zahlungen nicht lesbar → fail-closed", async () => {
    setup(planTables({ prepayment_tranches: [{ id: T1, trip_id: TRIP, label: "Endzahlung", due_date: "2027-04-10", percent: 100, sort_order: 0 }] }));
    fake.failOn({ table: "v_prepayment_payments", action: "select" });
    expect((await notifyPlanCrew(TRIP)).status).toBe("error");
    expect(mockedSendMails).not.toHaveBeenCalled();
  });

  it("Plan: Selbstmeldungen nicht lesbar → fail-closed", async () => {
    setup(planTables({ prepayment_tranches: [{ id: T1, trip_id: TRIP, label: "Endzahlung", due_date: "2027-04-10", percent: 100, sort_order: 0 }] }));
    fake.failOn({ table: "v_prepayment_pending", action: "select" });
    expect((await notifyPlanCrew(TRIP)).status).toBe("error");
    expect(mockedSendMails).not.toHaveBeenCalled();
  });

  it("Plan-Mail: Raten summieren exakt auf den Anteil (kein Cent-Drift)", async () => {
    setup(planTables({
      prepayment_plan: [{ trip_id: TRIP, advancer_person_id: null, wero_id: "", total_amount: 1000, crew_notified_at: "2026-01-01T00:00:00Z" }],
      prepayment_obligations: [{ trip_id: TRIP, person_id: ANNA, total_amount: 100.01 }],
      prepayment_tranches: [
        { id: T1, trip_id: TRIP, label: "1. Anzahlung", due_date: "2027-01-10", percent: 50, sort_order: 0 },
        { id: T2, trip_id: TRIP, label: "Endzahlung", due_date: "2027-04-10", percent: 50, sort_order: 1 },
      ],
    }));
    await notifyPlanCrew(TRIP);
    const anna = mails().find((m) => m.to === EMAIL[ANNA])!;
    expect(anna.text).toContain("1. Anzahlung bis 7.1.2027: 50,01 €");
    expect(anna.text).toContain("Endzahlung bis 7.4.2027: 50,00 €");
  });

  it("Zahlungen nicht lesbar → fail-closed, keine Update-Mail", async () => {
    setup(tables());
    fake.failOn({ table: "v_prepayment_item_payments", action: "select" });
    const res = await notifyItemCrew(TRIP, ITEM);
    expect(res.status).toBe("error");
    expect(mockedSendMails).not.toHaveBeenCalled();
  });

  it("Posten: Update-Mail an Betroffene; fremde Posten-ID → Fehler", async () => {
    setup(tables());
    const res = await notifyItemCrew(TRIP, ITEM);
    expect(res).toEqual({ status: "ok", sent: 2, failed: 0, skipped: 0 });
    expect(mails().every((m) => m.subject.startsWith("Posten geändert"))).toBe(true);
    expect(mailedTo()).toEqual([EMAIL[ANNA], EMAIL[BEN]].sort());

    mockedSendMails.mockClear();
    const foreign = await notifyItemCrew(TRIP, "aaaaaaaa-0000-4000-8000-0000000000d9");
    expect(foreign.status).toBe("error");
    expect(mockedSendMails).not.toHaveBeenCalled();
  });

  it("Posten: ohne Berechtigung → Fehler", async () => {
    setup(tables());
    mockedSkipper.mockResolvedValue({ ok: false, message: "Nur Skipper." });
    expect((await notifyItemCrew(TRIP, ITEM)).status).toBe("error");
    expect(mockedSendMails).not.toHaveBeenCalled();
  });

  it("ungültige IDs → Fehler ohne Rollenprüfung", async () => {
    expect((await notifyItemCrew("x", ITEM)).status).toBe("error");
    expect((await notifyPlanCrew("x")).status).toBe("error");
    expect(mockedSkipper).not.toHaveBeenCalled();
  });
});
