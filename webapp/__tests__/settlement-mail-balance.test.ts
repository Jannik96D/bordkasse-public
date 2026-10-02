// M1 (PR4a-Review): Saldo der Abrechnungsmail = Bordkasse (passt zum
// Zahlungsplan), Anzahlung/Posten getrennt ausgewiesen.
import { describe, expect, it } from "vitest";
import { splitMailBalances } from "@/lib/calc/settlement-balances";
import { renderSettlementMail } from "@/lib/email/settlement-template";

describe("splitMailBalances", () => {
  it("trennt Bordkasse und Anzahlung/Posten; ohne Sondertöpfe ist der Posten-Anteil 0", () => {
    const m = splitMailBalances(
      [{ person_id: "a", balance: -130 }, { person_id: "b", balance: 130 }],
      [{ person_id: "a", balance: -30 }, { person_id: "b", balance: 30 }],
    );
    expect(m.get("a")).toEqual({ kitty: -30, pool: -100 });
    expect(m.get("b")).toEqual({ kitty: 30, pool: 100 });
    const plain = splitMailBalances([{ person_id: "a", balance: 5 }], [{ person_id: "a", balance: 5 }]);
    expect(plain.get("a")).toEqual({ kitty: 5, pool: 0 });
  });

  it("Mail-Saldo stimmt mit dem Zahlungsplan überein, offene Posten stehen getrennt", () => {
    const { text } = renderSettlementMail({
      recipientName: "Anna", tripName: "T", tripDates: "x", balance: -30, poolBalance: -100,
      debts: [{ counterparty_name: "Ben", amount: 30, direction: "owes" }],
      appUrl: "https://example.test", skipperName: "S", tripType: "sailing",
    });
    expect(text).toContain("Du zahlst noch 30,00");
    expect(text).toContain("Du zahlst 30,00");
    expect(text).toContain("Laut Bilanz sind bei Anzahlung und weiteren Posten zusätzlich −100,00");
    expect(text).not.toMatch(/Posten[^\n]*du (zahlst|bekommst)/);
  });

  it("ohne offenen Posten-Anteil kein Zusatzsatz", () => {
    const { text } = renderSettlementMail({
      recipientName: "Anna", tripName: "T", tripDates: "x", balance: 0, poolBalance: 0,
      debts: [], appUrl: "https://example.test", skipperName: "S", tripType: "sailing",
    });
    expect(text).not.toContain("weiteren Posten");
  });
});
