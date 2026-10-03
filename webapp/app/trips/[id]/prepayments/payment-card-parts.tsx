"use client";

/**
 * Gemeinsame Bausteine für die Zahlungs-Karten (PR7): der Anzahlungsplan
 * („Yachtanzahlung") und jede weitere Zahlung (intern `item`) haben dieselbe
 * Anatomie, damit niemand zwei Bedienmuster lernen muss:
 *
 *   Kopf (Icon + Titel + Betrag + Frist/Fristen + Badge „Streckt vor: Name")
 *   → zwei Fortschrittsbalken „Von der Crew bezahlt" / „An Anbieter bezahlt"
 *   → Hinweisblock „Noch an Anbieter zu überweisen"
 *   → Personen-/Ratenliste (Inhalt je Karte)
 *   → Aktionsleiste in fester Reihenfolge:
 *     Einzahlung erfassen · Crew informieren · Bearbeiten (· Löschen)
 *
 * Intern heißen weitere Zahlungen `item`/`prepayment_items`; Nutzer sehen das
 * Wort „Posten" nicht mehr.
 */

import { useId, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Pencil } from "lucide-react";
import { Modal } from "@/components/modal";
import { formatEuro } from "@/lib/utils";
import { ITEM_OVERALL_LABEL, progressPercent, type ItemOverall, type ProviderDueInfo } from "@/lib/prepayments/item-ui";
import {
  ACTION_PROVIDER,
  ACTION_RECORD,
  LABEL_PROVIDER_OPEN,
} from "@/lib/prepayments/payment-words";

// ── Kopf ──────────────────────────────────────────────────────────────────

export function AdvancerBadge({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-primary/30 bg-navy-light/30 px-2 py-0.5 text-xs font-medium text-primary">
      Streckt vor: {name}
    </span>
  );
}

export function PaymentCardHeader({
  icon,
  title,
  titleId,
  amount,
  meta,
  advancerName,
  overall,
}: {
  icon: ReactNode;
  title: string;
  titleId: string;
  amount: number;
  /** Kategorie, Frist/Fristen u. Ä. — Fließtext neben dem Badge. */
  meta: ReactNode;
  advancerName: string | null;
  overall: ItemOverall;
}) {
  const done = overall === "complete";
  const warn = overall === "overpaid";
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {icon}
          <h3 id={titleId} className="min-w-0 truncate text-base font-semibold text-ink">
            {title}
          </h3>
        </div>
        <p className="shrink-0 text-base font-semibold tabular-nums text-ink">{formatEuro(amount)}</p>
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-soft">
        {meta}
        {advancerName && <AdvancerBadge name={advancerName} />}
      </p>
      <p
        className={`mt-2 inline-flex items-center gap-1.5 text-sm font-medium ${
          done ? "text-success" : warn ? "text-danger" : "text-ink-soft"
        }`}
      >
        {done ? (
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
        ) : warn ? (
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        ) : (
          <span aria-hidden="true">○</span>
        )}
        {ITEM_OVERALL_LABEL[overall]}
      </p>
    </>
  );
}

// ── Fortschritt ───────────────────────────────────────────────────────────

export function PaymentProgress({
  label,
  done,
  total,
  tone,
}: {
  label: string;
  done: number;
  total: number;
  tone?: "ok" | "warn";
}) {
  const pct = progressPercent(done, total);
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs text-ink-soft">
        <span>{label}</span>
        <span className="tabular-nums">
          <strong className="text-ink">{formatEuro(done)}</strong> von {formatEuro(total)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${formatEuro(done)} von ${formatEuro(total)}`}
        className="mt-1 h-2 overflow-hidden rounded-full bg-navy-light/50"
      >
        <div className={`h-full ${tone === "warn" ? "bg-danger" : "bg-primary"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ── Hinweisblock „Noch an Anbieter zu überweisen" ─────────────────────────

const OUTLINE_BTN =
  "inline-flex min-h-[44px] items-center gap-1 rounded-md border border-primary px-3 py-2 text-sm font-medium text-primary hover:bg-navy-light/30 focus:outline-none focus:ring-2 focus:ring-primary/20";

export function ProviderOpenBlock({
  open,
  due,
  action,
  children,
}: {
  open: number;
  due: ProviderDueInfo;
  /** Standard-Aktion „Überweisung an Anbieter erfassen" — Button (onClick) ODER Link (href). */
  action?: { onClick: () => void } | { href: string } | null;
  /** Zusatzdetails (z. B. Raten-Aufschlüsselung des Anzahlungsplans). */
  children?: ReactNode;
}) {
  const dueTone =
    due.kind === "overdue"
      ? "text-danger"
      : due.kind === "soon"
        ? "text-amber-700"
        : due.kind === "done"
          ? "text-success"
          : "text-ink-soft";
  return (
    <div className="mt-3 rounded-md border border-rule bg-paper-soft p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-primary">{LABEL_PROVIDER_OPEN}</p>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
        <p className={`text-sm ${dueTone}`}>
          {due.kind === "done" ? (
            <span className="inline-flex items-center gap-1.5 font-medium">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              {due.text}
            </span>
          ) : (
            <>
              <span aria-hidden="true">{due.kind === "overdue" ? "⏰ " : due.kind === "soon" ? "⚠ " : "○ "}</span>
              <strong className="tabular-nums">{formatEuro(open)}</strong> · {due.text}
            </>
          )}
        </p>
        {action && open > 0.005 &&
          ("href" in action ? (
            <Link href={action.href} className={OUTLINE_BTN}>
              {ACTION_PROVIDER}
            </Link>
          ) : (
            <button type="button" onClick={action.onClick} className={OUTLINE_BTN}>
              {ACTION_PROVIDER}
            </button>
          ))}
      </div>
      {children}
    </div>
  );
}

// ── Aktionsleiste ─────────────────────────────────────────────────────────

const ACTION_BASE =
  "inline-flex min-h-[44px] items-center gap-1 rounded-md border border-rule px-3 py-2 text-sm hover:border-primary/40 hover:bg-navy-light/20 focus:outline-none focus:ring-2 focus:ring-primary/20";

/** „Einzahlung erfassen" — erste Aktion jeder Karte. */
export function RecordPaymentButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex min-h-[44px] items-center gap-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-paper hover:bg-navy-dark focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
    >
      <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
      {ACTION_RECORD}
    </button>
  );
}

/** „Bearbeiten" — dritte Aktion jeder Karte (Link zum Wizard oder Modal-Button). */
export function EditButton({ onClick, href }: { onClick?: () => void; href?: string }) {
  const inner = (
    <>
      <Pencil className="h-4 w-4" aria-hidden="true" />
      Bearbeiten
    </>
  );
  if (href) {
    return (
      <Link href={href} className={ACTION_BASE}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={ACTION_BASE}>
      {inner}
    </button>
  );
}

/**
 * Feste Reihenfolge: Einzahlung erfassen · Crew informieren · Bearbeiten ·
 * (weitere, z. B. Löschen). Fehlende Slots entfallen, die Reihenfolge bleibt.
 */
export function PaymentActionBar({
  record,
  notify,
  edit,
  extra,
  children,
}: {
  record?: ReactNode;
  notify?: ReactNode;
  edit?: ReactNode;
  extra?: ReactNode;
  /** Meldungen/Hinweise unter der Leiste. */
  children?: ReactNode;
}) {
  if (!record && !notify && !edit && !extra) return null;
  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-start gap-2" role="group" aria-label="Aktionen">
        {record}
        {notify}
        {edit}
        {extra}
      </div>
      {children}
    </div>
  );
}

// ── Auswahl „Für wen?" (Einzahlung erfassen aus der Aktionsleiste) ─────────

export interface RecordOption {
  key: string;
  label: string;
  detail: string;
}

/**
 * Kleiner Dialog „Für wen?": die Aktionsleiste kennt noch keine Person, die
 * Einzahlungs-Dialoge brauchen aber eine (Zelle Person × Rate). Zeigt nur
 * Personen mit offenem Betrag; ein Tipp öffnet den passenden Dialog.
 */
export function RecordPickerModal({
  title,
  options,
  onPick,
  onClose,
}: {
  title: string;
  options: RecordOption[];
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  return (
    <Modal onClose={onClose} labelledBy={`${id}-t`}>
      <h2 id={`${id}-t`} className="text-base font-semibold text-primary">
        {title}
      </h2>
      <p className="mt-1 text-sm text-ink-soft">Für wen möchtest du eine Einzahlung erfassen?</p>
      {options.length === 0 ? (
        <p className="mt-4 rounded-md bg-paper-soft px-3 py-2 text-sm text-ink-soft">Es ist nichts mehr offen.</p>
      ) : (
        <ul className="mt-3 max-h-[50dvh] divide-y divide-rule overflow-y-auto rounded-md border border-rule">
          {options.map((o) => (
            <li key={o.key}>
              <button
                type="button"
                onClick={() => onPick(o.key)}
                className="flex min-h-[44px] w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-navy-light/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30"
              >
                <span className="min-w-0 truncate font-medium">{o.label}</span>
                <span className="shrink-0 tabular-nums text-ink-soft">{o.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end pt-3">
        <button type="button" onClick={onClose} className="min-h-[44px] rounded-md border border-rule px-4 py-2 text-sm hover:bg-navy-light/30">
          Abbrechen
        </button>
      </div>
    </Modal>
  );
}
