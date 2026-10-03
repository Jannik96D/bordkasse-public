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

import { useId, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, Bell, Check, CheckCircle2, MessageCircle, Pencil, RefreshCw, X } from "lucide-react";
import { useToast } from "@/components/toast-provider";
import { Modal } from "@/components/modal";
import { formatEuro } from "@/lib/utils";
import { formatDeDate } from "@/lib/prepayments/dates";
import type { RowsSummary } from "@/lib/prepayments/person-rows";
import { ITEM_OVERALL_LABEL, ITEM_STATUS_META, NETWORK_ERROR_MESSAGE, progressPercent, type ItemOverall, type ProviderDueInfo } from "@/lib/prepayments/item-ui";
import {
  ACTION_PROVIDER,
  ACTION_RECORD,
  LABEL_PROVIDER_OPEN,
  PAYMENT_STATUS,
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
  subtitle = "Für wen möchtest du eine Einzahlung erfassen?",
  options,
  onPick,
  onClose,
}: {
  title: string;
  subtitle?: string;
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
      <p className="mt-1 text-sm text-ink-soft">{subtitle}</p>
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

// ── Kennzahlen + Überzahlungs-Hinweis (beide Karten identisch) ────────────

export function PaymentSummaryLine({ summary, pendingCount, tooltip }: { summary: RowsSummary; pendingCount: number; tooltip?: ReactNode }) {
  return (
    <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-soft">
      <span><strong className="text-ink">{summary.fullyPaid}</strong> von {summary.withSoll} vollständig</span>
      {pendingCount > 0 && <span className="text-amber-700">{pendingCount} wartet auf Bestätigung</span>}
      {summary.overdue > 0 && <span className="text-danger">{summary.overdue} überfällig</span>}
      {tooltip}
    </p>
  );
}

export function OverpaidNote({ amount }: { amount: number }) {
  if (amount <= 0.005) return null;
  return (
    <p role="note" className="mt-3 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        <strong>{formatEuro(amount)} zu viel bezahlt.</strong> Der Mehrbetrag muss zurück an die betroffenen Personen —
        die App bucht das nicht automatisch.
      </span>
    </p>
  );
}

// ── Gemeldete Einzahlungen (Bestätigen/Ablehnen) ──────────────────────────

export interface PendingEntry {
  id: string;
  who: string;
  amount: number;
  /** „1. Anzahlung“ — leer bei weiteren Zahlungen. */
  what?: string;
  date: string;
}

type ActionResult = { status: string; message?: string };

function PendingReportActions({
  who,
  amount,
  onConfirm,
  onReject,
}: {
  who: string;
  amount: string;
  onConfirm: () => Promise<ActionResult>;
  onReject: () => Promise<ActionResult>;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(action: () => Promise<ActionResult>, okMessage: string) {
    setError(null);
    startTransition(async () => {
      let res: ActionResult;
      try {
        res = await action();
      } catch {
        setError(NETWORK_ERROR_MESSAGE);
        return;
      }
      if (res.status === "error") {
        setError(res.message ?? "Fehler");
        return;
      }
      toast.show(okMessage, { variant: "success" });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="inline-flex gap-1">
        <button
          type="button"
          onClick={() => run(onConfirm, "Einzahlung bestätigt.")}
          disabled={pending}
          aria-label={`Meldung von ${who} über ${amount} bestätigen`}
          title="Bestätigen"
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md bg-success px-3 py-1.5 text-paper hover:bg-success/90 focus:outline-none focus:ring-2 focus:ring-success/40 disabled:opacity-50"
        >
          {pending ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
        </button>
        <button
          type="button"
          onClick={() => run(onReject, "Meldung abgelehnt.")}
          disabled={pending}
          aria-label={`Meldung von ${who} über ${amount} ablehnen`}
          title="Ablehnen"
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-rule bg-paper px-3 py-1.5 text-danger hover:border-danger/40 focus:outline-none focus:ring-2 focus:ring-danger/40 disabled:opacity-50"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {error && <p role="alert" className="max-w-xs text-right text-xs text-danger">{error}</p>}
    </div>
  );
}

export function PendingReportsBanner({
  entries,
  ariaSubject,
  confirm,
  reject,
}: {
  entries: PendingEntry[];
  /** Wofür (Screenreader-Beschriftung), z. B. Titel der Karte. */
  ariaSubject: string;
  /** Ohne Funktionen (Crew) nur Anzeige. */
  confirm?: (id: string) => Promise<ActionResult>;
  reject?: (id: string) => Promise<ActionResult>;
}) {
  if (entries.length === 0) return null;
  return (
    <section
      role="region"
      aria-label={`Gemeldete Einzahlungen für ${ariaSubject} — ${PAYMENT_STATUS.pending}`}
      className="mt-3 rounded-md border border-rule border-l-4 border-l-primary bg-paper p-3"
    >
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-primary">
        <span aria-hidden="true">⏳</span> {entries.length} {entries.length === 1 ? "Meldung wartet" : "Meldungen warten"} auf Bestätigung
      </p>
      <ul className="space-y-1.5">
        {entries.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-paper-soft px-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <strong>{p.who}</strong> hat <strong className="text-primary">{formatEuro(p.amount)}</strong>
              {p.what && <> für <strong>{p.what}</strong></>} gemeldet
              <span className="block text-xs text-ink-soft">{formatDeDate(p.date)}</span>
            </div>
            {confirm && reject && (
              <PendingReportActions
                who={p.who}
                amount={formatEuro(p.amount)}
                onConfirm={() => confirm(p.id)}
                onReject={() => reject(p.id)}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Erinnerungs-Glocke (🔔) je Person ─────────────────────────────────────

export function ReminderBell({
  onSend,
  disabled,
  title,
}: {
  onSend: () => Promise<ActionResult>;
  disabled: boolean;
  title: string;
}) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  // Sichtbares Feedback (Toast) statt nur sr-only/Tooltip — auf Touch gibt es keinen Tooltip.
  function send() {
    startTransition(async () => {
      try {
        const res = await onSend();
        if (res.status === "error") toast.show(res.message ?? "Fehler", { variant: "error" });
        else toast.show("Erinnerung verschickt.", { variant: "success" });
      } catch {
        toast.show(NETWORK_ERROR_MESSAGE, { variant: "error" });
      }
    });
  }

  return (
    <button
      type="button"
      onClick={send}
      disabled={disabled || pending}
      title={title}
      aria-label={title}
      className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-rule p-1.5 text-primary hover:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-40"
    >
      {pending ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Bell className="h-4 w-4" aria-hidden="true" />}
    </button>
  );
}

// ── Statuslegende (kurz, in beiden Karten gleich) ─────────────────────────

export function StatusLegend({ bell = false, whatsapp = false }: { bell?: boolean; whatsapp?: boolean }) {
  const states = ["open", "pending", "underpaid", "paid", "overpaid"] as const;
  return (
    <details className="mt-3 rounded-md border border-rule bg-paper-soft px-3 py-2 text-sm">
      <summary className="inline-flex min-h-[44px] cursor-pointer items-center text-ink-soft">Was bedeuten die Symbole?</summary>
      <ul className="mb-1 grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2">
        {states.map((st) => {
          const m = ITEM_STATUS_META[st];
          return (
            <li key={st} className="flex items-center gap-2">
              <span
                className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] font-bold leading-none ${m.box.replace("text-base", "")}`}
                aria-hidden="true"
              >
                {m.glyph}
              </span>
              {m.label}
            </li>
          );
        })}
        {bell && (
          <li className="flex items-center gap-2">
            <Bell className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            Erinnerung per Mail
          </li>
        )}
        {whatsapp && (
          <li className="flex items-center gap-2">
            <MessageCircle className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            WhatsApp-Text
          </li>
        )}
      </ul>
    </details>
  );
}
