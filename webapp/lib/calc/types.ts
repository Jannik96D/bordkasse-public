/**
 * TS-Spiegel der Datenmodell-Typen aus supabase/migrations/0001_init.sql.
 * Wird von lib/calc/* genutzt — Vitest-Tests prüfen damit S1–S7 ohne DB.
 */

export type SplitType =
  | "equal"
  | "on_board"
  | "time_proportional"
  | "individual"
  | "per_person";
export type TransactionType = "expense" | "credit";
/**
 * Trinkgeld-Verteilung bei "Pro Person":
 *   - 'proportional': anteilig zum Rechnungsbetrag (Standard, wer mehr bestellt zahlt anteilig mehr)
 *   - 'equal': gleichmäßig auf alle Beteiligten (jeder zahlt gleichviel Trinkgeld)
 * Für andere Aufteilungsarten ohne Trinkgeld irrelevant.
 */
export type TipDistribution = "proportional" | "equal";

export interface Member {
  personId: string;
  displayName: string;
  isAlcoholic: boolean;
  effectiveFrom: string; // ISO date YYYY-MM-DD
  effectiveTo: string;
  days: number;
}

export interface Transaction {
  id: string;
  type: TransactionType;
  date: string;          // ISO date
  amount: number;
  alcoholAmount: number;
  /** Trinkgeld in € (zusätzlich zum amount). Default 0. */
  tipAmount?: number;
  /** Verteilungsart des Trinkgelds bei "Pro Person". Default 'proportional'. */
  tipDistribution?: TipDistribution;
  // expense:
  paidBy?: string;
  splitType?: SplitType;
  participants?: string[]; // für split_type='individual'
  /** Per-Person-Beträge für split_type='per_person'. Personen ohne Eintrag oder mit Betrag 0 sind nicht beteiligt. */
  participantAmounts?: Array<{ personId: string; amount: number }>;
  // credit:
  creditFrom?: string;
  creditTo?: string | null; // null = "An Alle"
}

export interface Share {
  transactionId: string;
  personId: string;
  share: number;
}

export interface BalanceRow {
  personId: string;
  paid: number;
  share: number;
  creditGiven: number;
  creditReceived: number;
  balance: number;
}

export interface DebtTransfer {
  fromPersonId: string;
  toPersonId: string;
  amount: number;
}
