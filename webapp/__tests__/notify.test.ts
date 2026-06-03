// Tests für die Web-Push-Schicht: reine Payloads + Empfänger-Politik +
// Versand-Adapter (mit gemocktem web-push + Fake-Supabase-Client).
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() },
}));

import {
  settlementAnnouncedPush,
  settlementUpdatedPush,
  debtSettledPush,
  prepaymentReminderPush,
  charterReminderPush,
  paymentPendingPush,
  paymentConfirmedPush,
  paymentRejectedPush,
} from "@/lib/notify/payloads";
import { pushRecipients } from "@/lib/notify/recipients";

// ── Reine Payload-Builder ───────────────────────────────────────────────
describe("payloads", () => {
  it("settlement announce: Titel, Ziel-URL, Collapse-Tag", () => {
    const p = settlementAnnouncedPush("Ostsee 2026", "trip1");
    expect(p.title).toBe("Törn abgerechnet");
    expect(p.url).toBe("/trips/trip1/debts");
    expect(p.tag).toBe("settlement-trip1");
    expect(p.body).toContain("Ostsee 2026");
  });

  it("settlement update teilt den Tag mit der Ankündigung (ersetzt sie)", () => {
    expect(settlementUpdatedPush("X", "trip1").tag).toBe(settlementAnnouncedPush("X", "trip1").tag);
  });

  it("debt: Gläubiger-Empfänger → „als bezahlt markiert“", () => {
    const p = debtSettledPush({
      recipientRole: "creditor",
      actorRole: "debtor",
      actorName: "Lucas",
      amount: 20,
      tripId: "t",
      fromPersonId: "a",
      toPersonId: "b",
    });
    expect(p.body).toContain("Lucas");
    expect(p.body).toContain("als bezahlt markiert");
    expect(p.body).toContain("20,00");
  });

  it("debt: Schuldner-Empfänger bei Gläubiger-Aktion → „Empfang bestätigt“", () => {
    const p = debtSettledPush({
      recipientRole: "debtor",
      actorRole: "creditor",
      actorName: "Anna",
      amount: 5,
      tripId: "t",
      fromPersonId: "a",
      toPersonId: "b",
    });
    expect(p.body).toContain("Empfang");
    expect(p.body).toContain("bestätigt");
  });

  it("debt: Schuldner-Empfänger bei Admin-Aktion → neutrales „abgehakt“", () => {
    const p = debtSettledPush({
      recipientRole: "debtor",
      actorRole: "other",
      actorName: "Admin",
      amount: 5,
      tripId: "t",
      fromPersonId: "a",
      toPersonId: "b",
    });
    expect(p.body).toContain("abgehakt");
  });

  it("prepayment-/charter-/pending-/confirm-/reject-Payloads zeigen sinnvolle URLs", () => {
    expect(prepaymentReminderPush({ trancheLabel: "1. Anzahlung", amount: 180, tripName: "T", tripId: "t", trancheId: "x" }).url).toBe("/trips/t/prepayments");
    expect(prepaymentReminderPush({ trancheLabel: "1. Anzahlung", amount: 180, tripName: "T", tripId: "t", trancheId: "x" }).body).toContain("180,00");
    expect(charterReminderPush({ tripName: "T", tripId: "t", trancheId: "x" }).tag).toBe("charter-x");
    expect(paymentPendingPush({ payerName: "Mara", amount: 90, tripId: "t", trancheId: "tr1", payerPersonId: "pA" }).body).toContain("Mara");
    expect(paymentConfirmedPush({ amount: 90, tripId: "t" }).title).toBe("Zahlung bestätigt");
    expect(paymentRejectedPush({ amount: 90, tripId: "t" }).title).toBe("Zahlung abgelehnt");
  });

  it("settlement-Pushes setzen alwaysShow (kein Realtime-Toast für `trips`)", () => {
    expect(settlementAnnouncedPush("X", "t").alwaysShow).toBe(true);
    expect(settlementUpdatedPush("X", "t").alwaysShow).toBe(true);
  });

  it("pending-Tags zweier Melder kollidieren nicht (kein Collapse)", () => {
    const a = paymentPendingPush({ payerName: "Mara", amount: 90, tripId: "t", trancheId: "tr1", payerPersonId: "pA" });
    const b = paymentPendingPush({ payerName: "Tom", amount: 90, tripId: "t", trancheId: "tr1", payerPersonId: "pB" });
    expect(a.tag).not.toBe(b.tag);
  });
});

// ── Empfänger-Politik (Actor-Exclusion / Dedup) ──────────────────────────
describe("pushRecipients", () => {
  it("entfernt den Auslöser und dedupliziert", () => {
    expect(pushRecipients(["a", "b", "a"], { excludeActorId: "a" })).toEqual(["b"]);
  });
  it("filtert leere Werte", () => {
    expect(pushRecipients([null, undefined, "", "c"])).toEqual(["c"]);
  });
  it("ohne Actor bleiben alle (dedupliziert)", () => {
    expect(pushRecipients(["x", "y", "x"])).toEqual(["x", "y"]);
  });
});

// ── Versand-Adapter ──────────────────────────────────────────────────────
type Sub = { id: string; endpoint: string; p256dh: string; auth: string };

function makeSupabase(subs: Sub[]) {
  const deleted: string[] = [];
  const client = {
    from() {
      return {
        select() {
          return { in: async () => ({ data: subs, error: null }) };
        },
        delete() {
          return {
            in: async (_col: string, ids: string[]) => {
              deleted.push(...ids);
              return { error: null };
            },
          };
        },
      };
    },
    _deleted: deleted,
  };
  return client;
}

const sub = (id: string): Sub => ({ id, endpoint: `https://push.example/${id}`, p256dh: "k", auth: "a" });
const payload = { title: "T", body: "B", url: "/trips/t/debts", tag: "x" };

describe("sendPushToPersons", () => {
  beforeEach(() => {
    vi.resetModules();
    // Der web-push-Mock ist datei-global und überlebt resetModules → Call-
    // Historie pro Test zurücksetzen, sonst akkumulieren die Zähler.
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "test-public";
    process.env.VAPID_PRIVATE_KEY = "test-private";
    process.env.VAPID_SUBJECT = "mailto:test@example.com";
  });

  it("schickt an alle Geräte-Abos der Personen", async () => {
    const webpush = (await import("web-push")).default;
    (webpush.sendNotification as Mock).mockResolvedValue({ statusCode: 201 });
    const { sendPushToPersons } = await import("@/lib/notify/web-push");

    const supa = makeSupabase([sub("s1"), sub("s2")]);
    const res = await sendPushToPersons(supa as never, ["p1", "p2"], payload);

    expect((webpush.sendNotification as Mock).mock.calls.length).toBe(2);
    expect(res.sent).toBe(2);
    expect(res.failed).toBe(0);
    expect(res.removed).toBe(0);
  });

  it("löscht tote Abos (HTTP 410) und zählt sie als removed, nicht failed", async () => {
    const webpush = (await import("web-push")).default;
    (webpush.sendNotification as Mock).mockRejectedValue({ statusCode: 410 });
    const { sendPushToPersons } = await import("@/lib/notify/web-push");

    const supa = makeSupabase([sub("s1"), sub("s2")]);
    const res = await sendPushToPersons(supa as never, ["p1"], payload);

    expect(res.removed).toBe(2);
    expect(res.failed).toBe(0);
    expect(res.sent).toBe(0);
    expect(supa._deleted.sort()).toEqual(["s1", "s2"]);
  });

  it("echte Zustellfehler (500) zählen als failed, werfen aber nicht", async () => {
    const webpush = (await import("web-push")).default;
    (webpush.sendNotification as Mock).mockRejectedValue({ statusCode: 500 });
    const { sendPushToPersons } = await import("@/lib/notify/web-push");

    const supa = makeSupabase([sub("s1")]);
    const res = await sendPushToPersons(supa as never, ["p1"], payload);

    expect(res.failed).toBe(1);
    expect(res.removed).toBe(0);
    expect(supa._deleted).toEqual([]);
  });

  it("ohne Empfänger oder ohne VAPID ein No-Op (kein web-push-Call)", async () => {
    const webpush = (await import("web-push")).default;
    const { sendPushToPersons } = await import("@/lib/notify/web-push");

    // Keine Personen.
    expect(await sendPushToPersons(makeSupabase([sub("s1")]) as never, [], payload)).toEqual({
      sent: 0,
      failed: 0,
      removed: 0,
    });

    // VAPID fehlt → übersprungen.
    delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    vi.resetModules();
    const fresh = await import("@/lib/notify/web-push");
    const res = await fresh.sendPushToPersons(makeSupabase([sub("s1")]) as never, ["p1"], payload);
    expect(res).toEqual({ sent: 0, failed: 0, removed: 0 });
    expect((webpush.sendNotification as Mock).mock.calls.length).toBe(0);
  });

  it("wirft NICHT bei ungültiger VAPID-Konfiguration (setVapidDetails throws)", async () => {
    const webpush = (await import("web-push")).default;
    // Malformter Key/Subject in Env → setVapidDetails wirft. Das darf den
    // aufrufenden Action-Pfad NICHT sprengen (Vertrag wie sendMail).
    (webpush.setVapidDetails as Mock).mockImplementationOnce(() => {
      throw new Error("invalid vapid key");
    });
    const { sendPushToPersons } = await import("@/lib/notify/web-push");
    const res = await sendPushToPersons(makeSupabase([sub("s1")]) as never, ["p1"], payload);
    expect(res).toEqual({ sent: 0, failed: 0, removed: 0 });
    expect((webpush.sendNotification as Mock).mock.calls.length).toBe(0);
  });
});
