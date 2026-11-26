// Reply-To: optionaler Standard über MAIL_REPLY_TO (Zustellbarkeit), pro Mail überschreibbar.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sendMailFn = vi.fn(async () => ({ messageId: "id-1" }));
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: sendMailFn, close: () => {} }) },
}));

import { sendMail, sendMails } from "@/lib/email/send";

const ENV = { ...process.env };
const msg = { to: "a@example.com", subject: "S", html: "<p>x</p>", text: "x" };
const lastArg = () => (sendMailFn.mock.calls.at(-1) as unknown as [{ replyTo?: string }])[0];

beforeEach(() => {
  sendMailFn.mockClear();
  process.env.SMTP_HOST = "smtp.example.com";
  process.env.SMTP_PORT = "587";
  process.env.SMTP_USER = "u";
  process.env.SMTP_PASS = "p";
  delete process.env.MAIL_REPLY_TO;
});
afterEach(() => {
  process.env = { ...ENV };
});

describe("MAIL_REPLY_TO", () => {
  it("ohne Variable: kein Reply-To", async () => {
    await sendMail(msg);
    expect(lastArg().replyTo).toBeUndefined();
  });
  it("leere/Whitespace-Variable zählt als nicht gesetzt (Docker-ARG)", async () => {
    process.env.MAIL_REPLY_TO = "   ";
    await sendMail(msg);
    expect(lastArg().replyTo).toBeUndefined();
  });
  it("sendMail: Standard aus der Variable", async () => {
    process.env.MAIL_REPLY_TO = " antwort@example.com ";
    await sendMail(msg);
    expect(lastArg().replyTo).toBe("antwort@example.com");
  });
  it("sendMail: explizites replyTo gewinnt", async () => {
    process.env.MAIL_REPLY_TO = "antwort@example.com";
    await sendMail({ ...msg, replyTo: "skipper@example.com" });
    expect(lastArg().replyTo).toBe("skipper@example.com");
  });
  it("sendMails: Standard + Überschreiben je Mail", async () => {
    process.env.MAIL_REPLY_TO = "antwort@example.com";
    await sendMails([msg, { ...msg, replyTo: "skipper@example.com" }]);
    const calls = sendMailFn.mock.calls as unknown as [{ replyTo?: string }][];
    expect(calls.map((c) => c[0].replyTo)).toEqual(["antwort@example.com", "skipper@example.com"]);
  });
});
