/**
 * Reise-Posten (Migration 0058) — reine Oberflächen-Logik, ohne React/DB.
 *
 * Alles, was die Posten-Oberfläche (Matrix-Sektion, Crew-Karte, Formular,
 * Bilanz) an Entscheidungen trifft, steht hier als pure Funktion — damit es
 * per Vitest abgesichert werden kann und Server (Bilanz-Seite, Nav-Zustand)
 * und Client (Karten) dieselbe Regel nutzen.
 *
 * Spec: docs/prepayments.md, Abschnitt „Weitere Posten — Oberfläche (PR4b)".
 */

import { safeMathEval } from "@/lib/utils/math-eval";
import { parseAmountDe } from "@/lib/utils";
import { PAYMENT_STATUS } from "@/lib/prepayments/payment-words";
import type { ItemCellStatus, ItemSplitType } from "@/lib/calc/prepayment-item-shares";

/** Struktureller Ausschnitt von `PrepaymentItemView` (kein Server-Import im Client). */
export interface ItemLike {
  id: string;
  total_amount: number;
  due_date: string | null;
  payee_person_id: string;
  cells: { person_id: string; soll: number; paid: number; pending: number; status: ItemCellStatus }[];
  sollTotal: number;
  paidTotal: number;
  pendingTotal: number;
  overpaidTotal: number;
  underpaidTotal: number;
  providerPaid: number;
  providerOpen: number;
  providerOverdue: boolean;
  complete: boolean;
}

// ────────────────────────────────────────────────────────────────────────
// Status einer Zelle: Icon UND Text (nie nur Farbe)
// ────────────────────────────────────────────────────────────────────────

export interface StatusMeta {
  /** Symbol (aria-hidden anzeigen, der Text trägt die Aussage). */
  glyph: string;
  label: string;
  /** Tailwind-Klassen für das Symbol-Kästchen. */
  box: string;
  /** Tailwind-Textfarbe für die Beschriftung. */
  text: string;
}

export const ITEM_STATUS_META: Record<ItemCellStatus, StatusMeta> = {
  open: { glyph: "○", label: "offen", box: "border-rule bg-paper text-ink-soft", text: "text-ink-soft" },
  pending: {
    glyph: "⏳",
    label: PAYMENT_STATUS.pending,
    box: "border-amber-400 bg-amber-50 text-base",
    text: "text-amber-700",
  },
  underpaid: { glyph: "◐", label: "teilweise bezahlt", box: "border-primary bg-paper text-primary", text: "text-primary" },
  paid: { glyph: "✓", label: "bezahlt", box: "border-success bg-success text-paper", text: "text-success" },
  overpaid: { glyph: "+", label: "überzahlt", box: "border-danger bg-danger/10 text-danger", text: "text-danger" },
};

/** Voller Kontext für Screenreader (Muster der Tranchen-Zellen). */
export function itemCellAriaLabel(args: {
  name: string;
  itemLabel: string;
  status: ItemCellStatus;
  soll: number;
  paid: number;
  pending: number;
  /** Formatter für Beträge (formatEuro) — injiziert, damit die Funktion pur bleibt. */
  fmt: (n: number) => string;
  actionable: boolean;
}): string {
  const { name, itemLabel, status, soll, paid, pending, fmt, actionable } = args;
  const parts = [`${name}, ${itemLabel}: ${ITEM_STATUS_META[status].label}`, `${fmt(paid)} von ${fmt(soll)} bezahlt`];
  const open = Math.max(0, soll - paid);
  if (open > 0.005) parts.push(`${fmt(open)} offen`);
  if (paid > soll + 0.005) parts.push(`${fmt(paid - soll)} zu viel`);
  if (pending > 0.005) parts.push(`${fmt(pending)} gemeldet`);
  return parts.join(", ") + (actionable ? ". Einzahlung erfassen" : "");
}

// ────────────────────────────────────────────────────────────────────────
// Gesamtstatus eines Postens
// ────────────────────────────────────────────────────────────────────────

export type ItemOverall = "complete" | "overpaid" | "crew_open" | "provider_open" | "empty";

/**
 * Ein Wort pro Posten für die Kopfzeile:
 *   complete      — alle Zellen exakt gedeckt UND Anbieter exakt bezahlt
 *   overpaid      — irgendwo zu viel gezahlt (Geld muss zurück) — geht vor allem anderen
 *   crew_open     — Crew schuldet noch Geld (oder Selbstmeldung offen)
 *   provider_open — Crew ist durch, der Anbieter ist noch nicht (voll) bezahlt
 *   empty         — kein Soll (kaputter Posten, z. B. alle Sollzeilen weg)
 */
export function itemOverallStatus(item: ItemLike): ItemOverall {
  if (item.complete) return "complete";
  if (!item.cells.some((c) => c.soll > 0.005)) return "empty";
  if (item.overpaidTotal > 0.005 || item.providerPaid > item.total_amount + 0.005) return "overpaid";
  if (item.underpaidTotal > 0.005 || item.pendingTotal > 0.005) return "crew_open";
  return "provider_open";
}

export const ITEM_OVERALL_LABEL: Record<ItemOverall, string> = {
  complete: "Abgeschlossen",
  overpaid: "Überzahlt — Rückzahlung klären",
  crew_open: "Zahlungen offen",
  provider_open: "Anbieter noch nicht bezahlt",
  empty: "Ohne Sollbeträge",
};

/**
 * Von der Gruppe bezahlt, gedeckelt PRO PERSON: Σ min(paid, soll). Eine
 * Überzahlung von A darf die offene Schuld von B nicht ausgleichen — mit
 * min(Σpaid, Σsoll) zeigte der Balken dann fälschlich 100 %.
 */
export function groupPaidCapped(cells: { soll: number; paid: number }[]): number {
  return cells.reduce((sum, c) => sum + Math.min(c.paid, c.soll), 0);
}

/** Posten, an denen die Person beteiligt ist (Empfänger, Soll, Zahlung, Meldung). */
export function itemsVisibleTo<T extends ItemLike>(items: T[], personId: string | null): T[] {
  if (!personId) return [];
  return items.filter(
    (it) =>
      it.payee_person_id === personId ||
      it.cells.some((c) => c.person_id === personId && (c.soll > 0.005 || c.paid > 0.005 || c.pending > 0.005)),
  );
}

/** Meldung bei Netzwerkfehler einer Server-Action (Eingaben bleiben, Retry ist idempotent). */
export const NETWORK_ERROR_MESSAGE = "Keine Verbindung — bitte erneut versuchen.";

/** Fortschritt 0–100 (für Balken) — geklemmt, nie NaN. */
export function progressPercent(done: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

// ────────────────────────────────────────────────────────────────────────
// Anbieter-Zahlung: „Noch an Anbieter zu überweisen" (Pendant CharterReminderBanner)
// ────────────────────────────────────────────────────────────────────────

export type ProviderDueKind = "done" | "overdue" | "soon" | "open";

export interface ProviderDueInfo {
  kind: ProviderDueKind;
  /** Tage bis zur Fälligkeit (negativ = überfällig); null ohne Fälligkeit. */
  daysLeft: number | null;
  /** Kurztext für die Zeile, ohne Betrag. */
  text: string;
}

/** Tage zwischen zwei ISO-Daten (b − a), zeitzonenfrei über UTC. */
export function signedDaysBetween(aIso: string, bIso: string): number {
  const a = new Date(`${aIso}T00:00:00Z`).getTime();
  const b = new Date(`${bIso}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

const dayWord = (n: number) => `${n} Tag${n === 1 ? "" : "en"}`;

export function providerDueInfo(
  item: Pick<ItemLike, "due_date" | "providerOpen">,
  today: string,
  formatDate: (iso: string) => string,
): ProviderDueInfo {
  if (item.providerOpen <= 0.005) return { kind: "done", daysLeft: null, text: "vollständig an den Anbieter überwiesen" };
  if (!item.due_date) return { kind: "open", daysLeft: null, text: "keine Fälligkeit hinterlegt" };
  const daysLeft = signedDaysBetween(today, item.due_date);
  if (daysLeft < 0) return { kind: "overdue", daysLeft, text: `seit ${dayWord(-daysLeft)} überfällig` };
  if (daysLeft <= 14) {
    return { kind: "soon", daysLeft, text: daysLeft === 0 ? "heute fällig" : `in ${dayWord(daysLeft)} fällig` };
  }
  return { kind: "open", daysLeft, text: `fällig ${formatDate(item.due_date)}` };
}

// ────────────────────────────────────────────────────────────────────────
// Gesperrte Änderungen — als Hinweis statt stumm (Server bleibt Autorität)
// ────────────────────────────────────────────────────────────────────────

export interface ItemLocks {
  /** Betrag / Aufteilung / Einzelbeträge gesperrt (Anbieter-Zahlung gebucht). */
  distributionLocked: boolean;
  distributionReason: string | null;
  /** Empfängerwechsel gesperrt. */
  payeeLocked: boolean;
  payeeReason: string | null;
  /** Löschen gesperrt — Grund oder null. */
  deleteReason: string | null;
}

export function itemLocks(item: ItemLike): ItemLocks {
  const providerPaid = item.providerPaid > 0.005;
  const confirmedCrew = item.cells.some((c) => c.paid > 0.005);
  const pending = item.pendingTotal > 0.005;
  const livingCredits = confirmedCrew || pending;

  const distributionReason = providerPaid
    ? "Hier ist schon eine Überweisung an den Anbieter gebucht. Betrag und Aufteilung lassen sich danach nicht mehr ändern. Lösche zuerst die Überweisung in der Buchungsliste und erfasse sie nach der Änderung neu."
    : null;
  const payeeReason = providerPaid
    ? "Die vorstreckende Person hat schon an den Anbieter überwiesen und lässt sich deshalb nicht mehr wechseln."
    : livingCredits
      ? "An die vorstreckende Person wurde schon eingezahlt bzw. eine Einzahlung gemeldet. Sie lässt sich erst wechseln, wenn diese Einzahlungen gelöscht bzw. die Meldungen abgelehnt sind."
      : null;
  const deleteReason =
    providerPaid || confirmedCrew
      ? "Löschen nicht möglich: Es hängen bestätigte Zahlungen daran. Lösche sie bei Bedarf zuerst in der Buchungsliste."
      : pending
        ? "Löschen nicht möglich: Eine Meldung wartet noch auf Bestätigung. Bitte erst bestätigen oder ablehnen."
        : null;

  return {
    distributionLocked: providerPaid,
    distributionReason,
    payeeLocked: payeeReason !== null,
    payeeReason,
    deleteReason,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Formular: Beträge, Einzelbeträge, Payload
// ────────────────────────────────────────────────────────────────────────

/**
 * Zahlen in einem Rechenausdruck deutsch lesen, bevor `safeMathEval`
 * (kennt nur den Punkt als Dezimaltrenner) ihn sieht. Sonst würde
 * „3.700 - 3" als 3,7 − 3 = 0,7 ausgewertet. Regel wie `parseAmountDe`:
 * Mit Komma sind Punkte Tausendertrenner; ohne Komma nur beim Muster
 * `1.234(.567)*` — „3.7" bleibt 3,7.
 */
function normalizeNumbersDe(expr: string): string {
  return expr.replace(/\d[\d.,]*/g, (tok) => {
    const n = parseAmountDe(tok);
    return n === null ? tok : String(n);
  });
}

/**
 * Betragsfeld auswerten: reine Zahl (deutsches Komma, Tausenderpunkt) ODER
 * Rechenausdruck („1200 - 150,50", „3.700 - 100", „480 / 4"). `null` = nicht
 * auswertbar. Ein Punkt mit genau drei Ziffern danach gilt immer als
 * Tausendertrenner („3.700" = 3700), sonst als Dezimalpunkt („3.7" = 3,7).
 */
export function evalItemAmount(raw: string): number | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (/^[\d.,\s]+$/.test(s)) {
    const n = parseAmountDe(s.replace(/\s/g, ""));
    if (n !== null) return Math.round(n * 100) / 100;
  }
  return safeMathEval(normalizeNumbersDe(s));
}

/** Σ Einzelbeträge (Texte) in Cent; nicht auswertbare/leere Felder zählen 0. */
export function individuellSumCents(amounts: Record<string, string>): number {
  let sum = 0;
  for (const raw of Object.values(amounts)) {
    const n = evalItemAmount(raw);
    if (n !== null && n > 0) sum += Math.round(n * 100);
  }
  return sum;
}

/** Differenz Σ Einzelbeträge − Posten-Betrag in Cent (0 = passt). */
export function individuellDiffCents(total: number | null, amounts: Record<string, string>): number {
  return individuellSumCents(amounts) - Math.round((total ?? 0) * 100);
}

export interface ItemFormState {
  tripId: string;
  id: string;
  categoryId: string | null;
  label: string;
  amountText: string;
  dueDate: string;
  payeeId: string;
  splitType: ItemSplitType;
  /** person_id → Betragstext, nur für „individuell". */
  amounts: Record<string, string>;
  redistribute: boolean;
  sortOrder: number;
}

export type PayloadResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; message: string; field?: string };

/**
 * Formularzustand → JSON für `saveItem`. Prüft nur, was der Server ohnehin
 * prüft, aber mit früherer, feldgenauer Meldung (Zahlenformat, Rechenfeld).
 * Der Server bleibt Autorität (Summe, Cross-Trip, Rollen).
 */
export function buildSaveItemPayload(s: ItemFormState): PayloadResult {
  const total = evalItemAmount(s.amountText);
  if (!s.label.trim()) return { ok: false, message: "Bitte eine Bezeichnung eingeben.", field: "label" };
  if (total === null || !(total > 0)) return { ok: false, message: "Bitte einen Betrag größer als 0 eingeben.", field: "total_amount" };
  const obligations: { person_id: string; amount: string }[] = [];
  if (s.splitType === "individuell") {
    for (const [personId, raw] of Object.entries(s.amounts)) {
      if (!raw.trim()) continue;
      const n = evalItemAmount(raw);
      if (n === null) return { ok: false, message: "Ein Einzelbetrag ist keine gültige Zahl.", field: "obligations" };
      if (n > 0) obligations.push({ person_id: personId, amount: n.toFixed(2).replace(".", ",") });
    }
    if (obligations.length === 0) return { ok: false, message: "Bitte mindestens einen Einzelbetrag eintragen.", field: "obligations" };
  }
  return {
    ok: true,
    payload: {
      trip_id: s.tripId,
      id: s.id,
      category_id: s.categoryId,
      label: s.label.trim(),
      total_amount: total.toFixed(2).replace(".", ","),
      due_date: s.dueDate || null,
      payee_person_id: s.payeeId || null,
      split_type: s.splitType,
      obligations,
      redistribute: s.splitType === "individuell" ? false : s.redistribute,
      sort_order: s.sortOrder,
    },
  };
}

/** Vorbelegung der Kategorie: „An-/Abreise" falls vorhanden, sonst leer (Bestandstörns). */
export function defaultItemCategoryId(categories: { id: string; name: string }[]): string | null {
  const norm = (n: string) => n.toLowerCase().replace(/\s+/g, "");
  return categories.find((c) => norm(c.name) === "an-/abreise")?.id ?? null;
}

// ────────────────────────────────────────────────────────────────────────
// Sichtbarkeit des Anzahlungen-Tabs für Posten
// ────────────────────────────────────────────────────────────────────────

/**
 * Soll der Anzahlungen-Tab wegen Posten sichtbar sein? Gleiche Idee wie beim
 * Plan (Tab nur, wenn für die Person etwas zu tun ist):
 *   Skipper/Admin — irgendein Posten ist nicht abgeschlossen
 *   Empfänger     — eigener Posten nicht abgeschlossen
 *   Crew          — eigene Zelle nicht exakt gedeckt oder Meldung offen
 */
export function itemsNavRelevant(
  items: ItemLike[],
  viewer: { personId: string | null; isManager: boolean },
): boolean {
  for (const it of items) {
    if (viewer.isManager && !it.complete) return true;
    if (!viewer.personId) continue;
    if (it.payee_person_id === viewer.personId && !it.complete) return true;
    const mine = it.cells.find((c) => c.person_id === viewer.personId);
    if (mine && (mine.soll > 0.005 || mine.paid > 0.005 || mine.pending > 0.005) && mine.status !== "paid") return true;
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────────
// Anzahlungsplan: noch an den Anbieter zu überweisen (Rundungsrand)
// ────────────────────────────────────────────────────────────────────────

/** Rundungstoleranz: ≤ 1 ct Rest gilt als erledigt (3 × 33,33 € von 100,00 €). */
export const PROVIDER_REST_TOLERANCE = 0.01;

/**
 * Rest an den Anbieter aus den RATEN-Soll-Beträgen (je Rate auf Cent gerundet)
 * statt aus der Plansumme: 100,00 € in 3 × 33,33 € → Σ Soll 99,99 €; sind alle
 * Raten überwiesen, bleibt nichts offen. Rest ≤ 1 ct zählt als erledigt.
 */
export function planProviderRemaining(
  totalAmount: number,
  tranches: { id: string; percent: number }[],
  paidByTranche: Record<string, number>,
): { outstanding: number; nextOpenId: string | null } {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const sollOf = (t: { percent: number }) => r2((totalAmount * t.percent) / 100);
  const sumSoll = tranches.reduce((s, t) => s + sollOf(t), 0);
  const sumPaid = tranches.reduce((s, t) => s + (paidByTranche[t.id] ?? 0), 0);
  const rest = r2(sumSoll - sumPaid);
  const outstanding = rest > PROVIDER_REST_TOLERANCE + 1e-9 ? rest : 0;
  const next =
    outstanding > 0
      ? tranches.find((t) => r2(sollOf(t) - (paidByTranche[t.id] ?? 0)) > PROVIDER_REST_TOLERANCE + 1e-9)
      : undefined;
  return { outstanding, nextOpenId: next?.id ?? null };
}
