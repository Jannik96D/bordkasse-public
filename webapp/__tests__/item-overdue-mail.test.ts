import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMail = vi.fn(async () => ({ ok: true as const }));
vi.mock("@/lib/email/send", () => ({ sendMail: (...a: unknown[]) => (sendMail as (...x: unknown[]) => unknown)(...a) }));

import { sendItemReminderMail } from "@/lib/email/send-item-reminder";
import { renderItemCrewReminderMail } from "@/lib/email/item-reminder-template";

const ANNA = "aaaaaaaa-0000-4000-8000-000000000002";
const JAN = "aaaaaaaa-0000-4000-8000-000000000001";

const supabase = {
  from: (t: string) =>
    t === "persons"
      ? { select: () => ({ in: async () => ({ data: [{ id: ANNA, display_name: "Anna" }, { id: JAN, display_name: "Jannik" }], error: null }) }) }
      : { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: "a@x.test" }, error: null }) }) }) },
} as never;

const crewJob = { type: "item_crew_3d" as const, itemId: "i", tripId: "t", personId: ANNA, amount: 100, soll: 120 };
const payeeJob = {
  type: "item_payee_3d" as const, itemId: "i", tripId: "t", personId: JAN, amount: 260,
  overview: { providerSoll: 360, crewPaid: 140, crewSoll: 240, providerPaid: 100, providerOpen: 260, ownOpen: 0 },
};
const ctx = (dueDate: string, todayIso: string) => ({
  tripName: "Ostsee", tripType: "sailing" as const,
  item: { label: "Flüge", categoryName: null, dueDate, payeePersonId: JAN }, todayIso,
});
const sent = () => (sendMail.mock.calls[0] as unknown as [{ subject: string; html: string; text: string }])[0];

beforeEach(() => sendMail.mockClear());

describe("Erinnerung nach verstrichener Frist", () => {
  it("Crew: „überfällig seit …“ statt einer auf heute geklemmten Crewfrist", async () => {
    await sendItemReminderMail(supabase, crewJob, ctx("2026-09-01", "2026-10-03"));
    const m = sent();
    expect(m.subject).toContain("überfällig seit 1.9.2026");
    expect(m.subject).not.toContain("bis 3.10.2026");
    expect(m.text).toContain("überfällig seit 1.9.2026");
    expect(m.text).toContain("schnellstmöglich");
    expect(m.text).not.toContain("bis 3.10.2026");
  });
  it("Empfänger: Übersicht nennt „überfällig seit …“", async () => {
    await sendItemReminderMail(supabase, { ...payeeJob }, ctx("2026-09-01", "2026-10-03"));
    const m = sent();
    expect(m.subject).toContain("überfällig seit 1.9.2026");
    expect(m.text).toContain("überfällig");
  });
  it("Frist heute oder in der Zukunft: unverändert „bis …“ (kein Überfällig-Text)", async () => {
    await sendItemReminderMail(supabase, crewJob, ctx("2026-10-03", "2026-10-03"));
    expect(sent().subject).not.toContain("überfällig");
    sendMail.mockClear();
    await sendItemReminderMail(supabase, crewJob, ctx("2026-10-12", "2026-10-03"));
    expect(sent().subject).toContain("bis 9.10.2026");
    expect(sent().text).not.toContain("überfällig");
  });
  it("Template escapt overdueSince", () => {
    const m = renderItemCrewReminderMail({
      recipientName: "A", payeeName: "B", tripName: "T", tripType: "sailing", item: { label: "L", categoryName: null },
      crewDueDate: "1.1.2027", overdueSince: `<b>x</b>`, amountOpen: 1, amountSoll: 1, appUrl: "https://x.test",
    });
    expect(m.html).not.toContain("<b>x</b>");
  });
});
