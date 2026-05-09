/**
 * TS-Spiegel der Datenmodell-Typen aus supabase/migrations/0001_init.sql.
 * Wird von lib/calc/* genutzt — Vitest-Tests prüfen damit S1–S7 ohne DB.
 */

export type SplitType = "equal" | "on_board" | "time_proportional" | "individual";
export type TransactionType = "expense" | "credit";

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
  // expense:
  paidBy?: string;
  splitType?: SplitType;
  participants?: string[]; // für split_type='individual'
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
