/**
 * Saldo-Aufteilung für die Abrechnungsmail (Entscheidung M1, PR4a-Review).
 *
 * Der Zahlungsplan der Mail kommt aus simplify_debts und deckt NUR die
 * Bordkasse ab. Damit Saldo und Zahlungsplan zusammenpassen, zeigt die Mail
 * als Hauptsaldo den Bordkasse-Saldo (v_balances_bordkasse_only) und weist
 * offene Beträge aus Anzahlung und Reise-Posten GETRENNT aus
 * (= Gesamtbilanz v_balances − Bordkasse). Ohne Anzahlungsplan und Posten
 * ist der getrennte Anteil 0 (beide Views schließen offene Selbstmeldungen
 * gleichermaßen aus).
 */

import { round2 } from "@/lib/utils";

export interface MailBalance {
  /** Bordkasse-Saldo (+ = bekommt, − = zahlt) — passt zum Zahlungsplan. */
  kitty: number;
  /** Anzahlung + weitere Posten (+ = bekommt, − = zahlt), nicht im Zahlungsplan. */
  pool: number;
}

export function splitMailBalances(
  total: { person_id: string; balance: number }[],
  kitty: { person_id: string; balance: number }[],
): Map<string, MailBalance> {
  const kittyBy = new Map(kitty.map((k) => [k.person_id, k.balance]));
  const out = new Map<string, MailBalance>();
  for (const t of total) {
    const k = kittyBy.get(t.person_id) ?? 0;
    out.set(t.person_id, { kitty: round2(k), pool: round2(t.balance - k) });
  }
  for (const k of kitty) {
    if (!out.has(k.person_id)) out.set(k.person_id, { kitty: round2(k.balance), pool: round2(-k.balance) });
  }
  return out;
}
