// Slice 9: ist die Abrechnung freigegeben, aber noch keine Mail zugestellt
// (settlement_mail_sent_at NULL, 0052), muss der Retry in der Oberfläche
// erreichbar sein — vorher gab es ihn nur serverseitig.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/settlement-resend-button", () => ({
  SettlementResendButton: ({ firstSend }: { firstSend?: boolean }) => (
    <button>{firstSend ? "Abrechnung erneut verschicken" : "Update-Mail verschicken"}</button>
  ),
}));
vi.mock("@/components/settlement-announce-button", () => ({ SettlementAnnounceButton: () => <button>announce</button> }));

import { SettlementStatus } from "@/components/settlement-status";
import { tripVocab } from "@/lib/trip-vocab";

const base = {
  tripId: "t",
  endDate: "2026-06-10",
  announcedAt: "2026-06-11T10:00:00.000Z",
  canAnnounce: true,
  vocab: tripVocab("sailing"),
};

describe("SettlementStatus — Erstversand nicht zugestellt", () => {
  it("zeigt bei mailSentAt = null den Hinweis mit Retry-Knopf", () => {
    const html = renderToStaticMarkup(<SettlementStatus {...base} mailSentAt={null} />);
    expect(html).toContain("noch nicht angekommen");
    expect(html).toContain("Abrechnung erneut verschicken");
  });

  it("zeigt nach erfolgreicher Zustellung den grünen Hinweis", () => {
    const html = renderToStaticMarkup(<SettlementStatus {...base} mailSentAt="2026-06-11T10:00:05.000Z" />);
    expect(html).toContain("Abrechnung verschickt");
    expect(html).not.toContain("erneut verschicken");
  });

  it("Update-Banner bei offener Änderung nach zugestellter Abrechnung", () => {
    const html = renderToStaticMarkup(
      <SettlementStatus {...base} mailSentAt="2026-06-11T10:00:05.000Z" changesPendingSince="2026-06-12T09:00:00.000Z" />,
    );
    expect(html).toContain("Update-Mail verschicken");
  });
});
