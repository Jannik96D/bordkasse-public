import { describe, it, expect } from "vitest";
import { renderPrepaymentNoticeMail } from "@/lib/email/prepayment-notice-template";

const baseParams = {
  kind: "payment_recorded" as const,
  recipientName: "Lucas",
  actorName: 'Max<script>alert(1)</script>',
  subjectPersonName: '<a href="https://evil.example">Klick mich</a>',
  amount: 120,
  trancheLabel: "1. Anzahlung",
  tripName: "Ostseetörn 2026",
  appUrl: "https://bordkasse.dieter.ms/trips/1/prepayments",
  tripType: "sailing" as const,
};

describe("renderPrepaymentNoticeMail — HTML-Escaping (Fund 1)", () => {
  it("escaped einen bösartigen Anzeigenamen im HTML-Body (introText + detailLine)", () => {
    const { html } = renderPrepaymentNoticeMail(baseParams);

    // Die rohen, gefährlichen Tags dürfen NICHT im HTML auftauchen.
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain('<a href="https://evil.example">Klick mich</a>');

    // Stattdessen escaped.
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;a href=&quot;https://evil.example&quot;&gt;Klick mich&lt;/a&gt;");
  });

  it("escaped den Namen sowohl in introText als auch in detailLine, nicht nur an einer Stelle", () => {
    const { html } = renderPrepaymentNoticeMail(baseParams);
    // subjectPersonName taucht zweimal auf: einmal im Fließtext (introText),
    // einmal in der Detail-Pille (detailLine).
    const occurrences = html.split("&lt;a href=&quot;https://evil.example&quot;&gt;Klick mich&lt;/a&gt;").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("escaped nicht doppelt vor-formatiertes HTML aus renderHintBlock/renderActionButton", () => {
    const { html } = renderPrepaymentNoticeMail({
      ...baseParams,
      advancerName: "Anna",
    });

    // renderActionButton nutzt escapeHtml(label) genau einmal -> darf nicht
    // doppelt escaped als &amp;lt;... auftauchen.
    expect(html).not.toContain("&amp;lt;");
    expect(html).not.toContain("&amp;gt;");
    expect(html).not.toContain("&amp;quot;");
    expect(html).not.toContain("&amp;amp;");

    // Der Hint-Block selbst muss weiterhin lesbar (einfach escaped) sein.
    expect(html).toContain("Anna");
  });

  it("lässt harmlose Namen unverändert lesbar", () => {
    const { html } = renderPrepaymentNoticeMail({
      ...baseParams,
      actorName: "Max Mustermann",
      subjectPersonName: "Lucas Schmidt",
    });
    expect(html).toContain("Max Mustermann");
    expect(html).toContain("Lucas Schmidt");
  });
});
