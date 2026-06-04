/**
 * Tests für das Reise-typ-abhängige Vokabular (lib/trip-vocab.ts) und den
 * Namens-Ableiter aus E-Mails (lib/utils.ts) — beide reine Funktionen, die im
 * Zuge des „Andere Reise"-Features bzw. der Crew-Anlage-Fixes entstanden sind.
 */
import { describe, expect, it } from "vitest";
import { tripVocab } from "@/lib/trip-vocab";
import { displayNameFromEmail } from "@/lib/utils";

describe("tripVocab", () => {
  it("liefert Segel-Begriffe für 'sailing'", () => {
    const v = tripVocab("sailing");
    expect(v.trip).toBe("Törn");
    expect(v.kitty).toBe("Bordkasse");
    expect(v.crew).toBe("Crew");
    expect(v.onBoard).toBe("An Bord");
    expect(v.cabin).toBe("Koje");
    expect(v.cabinPlural).toBe("Kojen");
    expect(v.skipper).toBe("Skipper");
    expect(v.coSkipper).toBe("Co-Skipper");
    expect(v.shipName).toBe("Schiffsname");
    expect(v.prepayment).toBe("Yachtanzahlung");
    expect(v.provider).toBe("Vercharterer");
    expect(v.openPrepayments).toBe("Offene Charteranzahlungen");
  });

  it("liefert neutrale Begriffe für 'other'", () => {
    const v = tripVocab("other");
    expect(v.trip).toBe("Reise");
    expect(v.kitty).toBe("Urlaubskasse");
    expect(v.crew).toBe("Reisegruppe");
    expect(v.onBoard).toBe("Anwesend");
    expect(v.cabin).toBe("Zimmer");
    expect(v.cabinPlural).toBe("Zimmer");
    expect(v.skipper).toBe("Reiseleitung");
    expect(v.coSkipper).toBe("Co-Reiseleitung");
    expect(v.shipName).toBe("Unterkunft");
    expect(v.prepayment).toBe("Urlaubsanzahlung");
    expect(v.provider).toBe("Anbieter");
    expect(v.openPrepayments).toBe("Offene Anzahlungen");
  });

  it("fällt bei unbekanntem/leerem Wert auf Segeltörn zurück", () => {
    expect(tripVocab(null).crew).toBe("Crew");
    expect(tripVocab(undefined).crew).toBe("Crew");
    expect(tripVocab("irgendwas").crew).toBe("Crew");
  });

  it("nutzt nicht die verbotene Bindestrich-Form 'Crew-Mitglied'", () => {
    // term-consistency.test.ts verbietet 'Crew-Mitglied' in app/+lib — der
    // Dativ-Begriff für den Realtime-Toast muss daher 'Crewmitglied' sein.
    expect(tripVocab("sailing").memberDative).toBe("Crewmitglied");
  });
});

describe("displayNameFromEmail", () => {
  it("nimmt den Teil vor dem @", () => {
    expect(displayNameFromEmail("lucas@example.com")).toBe("lucas");
    expect(displayNameFromEmail("Jannik.Dieter@beispiel.de")).toBe("Jannik.Dieter");
  });

  it("trimmt umgebenden Whitespace", () => {
    expect(displayNameFromEmail("  ab@c.de ")).toBe("ab");
  });

  it("liefert '' bei leerer/fehlender Eingabe", () => {
    expect(displayNameFromEmail("")).toBe("");
    expect(displayNameFromEmail(null)).toBe("");
    expect(displayNameFromEmail(undefined)).toBe("");
  });
});
