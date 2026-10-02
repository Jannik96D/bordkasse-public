"use client";

/**
 * „Weitere Posten" (Migration 0058, PR4b) — Sektion auf der Anzahlungs-Seite.
 *
 * Ein Posten ist ein eigener Topf neben der Charteranzahlung (z. B. Flüge für
 * die An-/Abreise). Pro Posten gibt es zwei Sichten, je nach Rolle:
 *   • ItemCard     — Skipper/Admin und der Empfänger des Postens: alle
 *     Personen mit Status, Selbstmeldungen bestätigen/ablehnen, Zahlungen
 *     erfassen, Zahlung an den Anbieter, (Skipper/Admin) bearbeiten/löschen.
 *   • ItemSelfCard — übrige Crew: nur die eigene Zeile + „Ich habe gezahlt".
 * Die Rolle wird serverseitig in jeder Action erneut geprüft; die Sicht hier
 * blendet nur aus, was ohnehin abgelehnt würde.
 *
 * Automatische Erinnerungen (PR5): der tägliche Anzahlungs-Cron erinnert die
 * Crew ab 6 Tagen vor der Fälligkeit beim Anbieter (= 3 Tage vor der
 * Crewfrist) und den Empfänger ab 3 Tagen davor — der Hinweis steht sichtbar
 * in der Sektion. Posten ohne Fälligkeit bekommen keine Erinnerung.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, CheckCircle2, AlertTriangle, Pencil, Plus, RefreshCw, Trash2, X, Info } from "lucide-react";
import { CategoryIcon } from "@/components/category-icon";
import { useConfirm } from "@/components/confirm-dialog";
import { useToast } from "@/components/toast-provider";
import { useTripVocab } from "@/components/trip-vocab-provider";
import { formatEuro } from "@/lib/utils";
import { formatDeDate, toCrewDueDate } from "@/lib/prepayments/dates";
import {
  ITEM_OVERALL_LABEL,
  ITEM_STATUS_META,
  itemCellAriaLabel,
  itemLocks,
  groupPaidCapped,
  itemOverallStatus,
  itemsVisibleTo,
  NETWORK_ERROR_MESSAGE,
  progressPercent,
  providerDueInfo,
} from "@/lib/prepayments/item-ui";
import {
  confirmItemSelfPayment,
  deleteItem,
  rejectItemSelfPayment,
  type ItemActionState,
} from "@/lib/actions/prepayment-items";
import type { PrepaymentItemView } from "@/lib/queries/prepayment-items";
import { ItemFormModal } from "./item-form-modal";
import { ItemPaymentModal, ItemProviderPaymentModal } from "./item-payment-modals";
import { NotifyCrewButton } from "./notify-crew-button";

interface Member {
  id: string;
  display_name: string;
}
interface Category {
  id: string;
  name: string;
  icon: string | null;
}

export interface ItemsSectionProps {
  tripId: string;
  items: PrepaymentItemView[];
  members: Member[];
  categories: Category[];
  viewerId: string | null;
  /** Skipper/Admin: Posten anlegen/bearbeiten/löschen, alles sehen. */
  canManageItems: boolean;
  /** Archivierte Törns sind schreibgeschützt (assertTripNotArchived). */
  readOnly: boolean;
  /** Vorbelegung des Empfängers beim Anlegen (Trip-Skipper). */
  defaultPayeeId: string | null;
  /** Heutiges Datum (ISO), vom Server — Server und Client rechnen damit identisch (kein Hydration-Mismatch). */
  today: string;
  /** Letzter Versand „Crew informieren" je Posten, server-seitig formatiert (PR6, fail-soft leer). */
  itemLastNotifiedLabel?: Record<string, string>;
}

/** Nur IDs merken: die Modale lesen Soll/Bezahlt/Locks nach jedem router.refresh frisch aus `items`. */
type PaymentTarget = { itemId: string; mode: "record" | "self"; personId: string };

export function ItemsSection({
  tripId,
  items,
  members,
  categories,
  viewerId,
  canManageItems,
  readOnly,
  defaultPayeeId,
  today,
  itemLastNotifiedLabel = {},
}: ItemsSectionProps) {
  const vocab = useTripVocab();
  const [form, setForm] = useState<{ itemId: string | null } | null>(null);
  const [payment, setPayment] = useState<PaymentTarget | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const itemById = new Map(items.map((i) => [i.id, i]));
  // Aktueller Stand der offenen Modale; verschwindet der Posten (anderswo gelöscht), schließt das Modal.
  const formItem = form?.itemId ? itemById.get(form.itemId) ?? null : null;
  const paymentItem = payment ? itemById.get(payment.itemId) ?? null : null;
  const paymentCell = payment && paymentItem ? paymentItem.cells.find((c) => c.person_id === payment.personId) : undefined;
  const provider = providerId ? itemById.get(providerId) ?? null : null;
  const nameById = new Map(members.map((m) => [m.id, m.display_name]));
  const nameOf = (id: string) => nameById.get(id) ?? vocab.member;

  // Crew sieht nur Posten, an denen sie beteiligt ist (Soll/Zahlung/Empfänger).
  const visible = canManageItems ? items : itemsVisibleTo(items, viewerId);

  if (visible.length === 0 && !canManageItems) return null;

  return (
    <section className="mt-8" aria-labelledby="items-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="items-heading" className="text-lg font-bold text-primary">Weitere Posten</h2>
        {canManageItems && !readOnly && (
          <button
            type="button"
            onClick={() => setForm({ itemId: null })}
            className="inline-flex min-h-[44px] items-center gap-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-paper hover:bg-navy-dark focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Posten hinzufügen
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-ink-soft">
        Zahlungen neben der {vocab.prepayment}, z. B. Flüge oder Bahn für die An-/Abreise: Eine Person zahlt vorab an
        den Anbieter und bekommt das Geld von der {vocab.crew} zurück.
      </p>
      {(canManageItems || visible.some((it) => it.payee_person_id === viewerId)) && (
        <p className="mt-2 flex items-start gap-2 rounded-md bg-paper-soft px-3 py-2 text-xs text-ink-soft">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span>
            Automatische Erinnerungen: Wer noch nicht gezahlt hat, bekommt 6 Tage vor der Fälligkeit beim Anbieter eine
            Mail (die {vocab.crew} soll 3 Tage vor dieser Fälligkeit zahlen). Der Empfänger bekommt 3 Tage vorher eine
            Übersicht, solange der Anbieter noch nicht voll bezahlt ist. Posten ohne Fälligkeit werden nicht erinnert.
            {canManageItems && (
              <>
                {" "}Beim Anlegen eines Postens bekommen alle mit Anteil automatisch eine Mail; nach einer Änderung
                informierst du sie über „{vocab.crew} informieren“.
              </>
            )}
          </span>
        </p>
      )}
      {readOnly && (
        <p role="note" className="mt-2 rounded-md bg-paper-soft px-3 py-2 text-xs text-ink-soft">
          Dieser {vocab.trip} ist archiviert — Posten sind schreibgeschützt.
        </p>
      )}

      {visible.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-primary/30 bg-navy-light/30 p-5 text-center text-sm text-ink-soft">
          Noch keine Posten angelegt.
        </p>
      ) : (
        <ul className="mt-4 space-y-4">
          {visible.map((it) => {
            const isPayee = it.payee_person_id === viewerId;
            const fullView = canManageItems || isPayee;
            return (
              <li key={it.id}>
                {fullView ? (
                  <ItemCard
                    tripId={tripId}
                    item={it}
                    payeeName={nameOf(it.payee_person_id)}
                    nameOf={nameOf}
                    canEdit={canManageItems && !readOnly}
                    canRecord={!readOnly}
                    today={today}
                    onEdit={() => setForm({ itemId: it.id })}
                    lastNotifiedLabel={itemLastNotifiedLabel[it.id] || null}
                    onRecord={(c) => setPayment({ itemId: it.id, mode: "record", personId: c.person_id })}
                    onProvider={() => setProviderId(it.id)}
                  />
                ) : (
                  <ItemSelfCard
                    item={it}
                    viewerId={viewerId}
                    payeeName={nameOf(it.payee_person_id)}
                    readOnly={readOnly}
                    onReport={(c) => setPayment({ itemId: it.id, mode: "self", personId: c.person_id })}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {form && (form.itemId === null || formItem) && (
        <ItemFormModal
          tripId={tripId}
          item={formItem}
          members={members}
          categories={categories}
          defaultPayeeId={defaultPayeeId}
          nextSortOrder={items.length}
          onClose={() => setForm(null)}
        />
      )}
      {payment && paymentItem && paymentCell && (
        <ItemPaymentModal
          tripId={tripId}
          itemId={paymentItem.id}
          itemLabel={paymentItem.label}
          mode={payment.mode}
          personId={payment.personId}
          personName={nameOf(payment.personId)}
          payeeName={nameOf(paymentItem.payee_person_id)}
          soll={paymentCell.soll}
          paid={paymentCell.paid}
          onClose={() => setPayment(null)}
        />
      )}
      {provider && (
        <ItemProviderPaymentModal
          tripId={tripId}
          itemId={provider.id}
          itemLabel={provider.label}
          total={provider.total_amount}
          providerPaid={provider.providerPaid}
          onClose={() => setProviderId(null)}
        />
      )}
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Bausteine
// ────────────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: keyof typeof ITEM_STATUS_META }) {
  const m = ITEM_STATUS_META[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${m.text}`}>
      <span
        className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border-2 text-sm font-bold leading-none ${m.box}`}
        aria-hidden="true"
      >
        {m.glyph}
      </span>
      {m.label}
    </span>
  );
}

function Progress({ label, done, total, tone }: { label: string; done: number; total: number; tone?: "ok" | "warn" }) {
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

function CardHeader({ item, payeeName, overall }: { item: PrepaymentItemView; payeeName: string; overall: ReturnType<typeof itemOverallStatus> }) {
  const done = overall === "complete";
  const warn = overall === "overpaid";
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <CategoryIcon icon={item.category_icon} name={item.category_name} className="h-5 w-5 shrink-0 text-primary" />
          <h3 id={`item-${item.id}-h`} className="min-w-0 truncate text-base font-semibold text-ink">{item.label}</h3>
        </div>
        <p className="shrink-0 text-base font-semibold tabular-nums text-ink">{formatEuro(item.total_amount)}</p>
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-soft">
        {item.category_name && <span>{item.category_name}</span>}
        {item.due_date && <span>· Fällig {formatDeDate(item.due_date)}</span>}
        <span className="inline-flex items-center rounded-full border border-primary/30 bg-navy-light/30 px-2 py-0.5 font-medium text-primary">
          Empfängt: {payeeName}
        </span>
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

// ────────────────────────────────────────────────────────────────────────
// Vollansicht (Skipper/Admin/Empfänger)
// ────────────────────────────────────────────────────────────────────────

function ItemCard({
  tripId,
  item,
  payeeName,
  nameOf,
  canEdit,
  canRecord,
  today,
  onEdit,
  lastNotifiedLabel,
  onRecord,
  onProvider,
}: {
  tripId: string;
  item: PrepaymentItemView;
  payeeName: string;
  nameOf: (id: string) => string;
  canEdit: boolean;
  canRecord: boolean;
  today: string;
  onEdit: () => void;
  lastNotifiedLabel: string | null;
  onRecord: (cell: PrepaymentItemView["cells"][number]) => void;
  onProvider: () => void;
}) {
  const overall = itemOverallStatus(item);
  const locks = itemLocks(item);
  const due = providerDueInfo(item, today, formatDeDate);
  const rows = item.cells
    .filter((c) => c.soll > 0.005 || c.paid > 0.005 || c.pending > 0.005)
    .map((c) => ({ ...c, name: nameOf(c.person_id) }))
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
  const dueTone =
    due.kind === "overdue" ? "text-danger" : due.kind === "soon" ? "text-amber-700" : due.kind === "done" ? "text-success" : "text-ink-soft";

  return (
    <article aria-labelledby={`item-${item.id}-h`} className="rounded-lg border border-rule bg-paper p-4">
      <CardHeader item={item} payeeName={payeeName} overall={overall} />

      <div className="mt-3 space-y-3">
        <Progress label={`Von der Gruppe an ${payeeName} bezahlt`} done={groupPaidCapped(item.cells)} total={item.sollTotal} />
        <Progress label="An den Anbieter bezahlt" done={Math.min(item.providerPaid, item.total_amount)} total={item.total_amount} tone={item.providerPaid > item.total_amount + 0.005 ? "warn" : undefined} />
      </div>

      {item.overpaidTotal > 0.005 && (
        <p role="note" className="mt-3 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            <strong>{formatEuro(item.overpaidTotal)} zu viel bezahlt.</strong> Der Mehrbetrag muss zurück an die
            betroffenen Personen — die App bucht das nicht automatisch.
          </span>
        </p>
      )}
      {item.underpaidTotal > 0.005 && (
        <p className="mt-3 text-xs text-ink-soft">
          Noch offen bei der Gruppe: <strong className="text-ink">{formatEuro(item.underpaidTotal)}</strong>
          {item.pendingTotal > 0.005 && <> (davon {formatEuro(item.pendingTotal)} gemeldet, noch nicht bestätigt)</>}.
        </p>
      )}

      {/* Anbieter-Block (Pendant CharterReminderBanner) */}
      <div className="mt-3 rounded-md border border-rule bg-paper-soft p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-primary">Noch an Anbieter zu überweisen</p>
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
                <strong className="tabular-nums">{formatEuro(item.providerOpen)}</strong> · {due.text}
              </>
            )}
          </p>
          {canRecord && item.providerOpen > 0.005 && (
            <button
              type="button"
              onClick={onProvider}
              className="inline-flex min-h-[44px] items-center gap-1 rounded-md border border-primary px-3 py-2 text-sm font-medium text-primary hover:bg-navy-light/30 focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              Zahlung an Anbieter erfassen
            </button>
          )}
        </div>
      </div>

      {item.pendingPayments.length > 0 && (
        <section
          role="region"
          aria-label={`Selbst gemeldete Zahlungen für ${item.label} — warten auf Bestätigung`}
          className="mt-3 rounded-md border border-rule border-l-4 border-l-primary bg-paper p-3"
        >
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-primary">
            <span aria-hidden="true">⏳</span> {item.pendingPayments.length} Selbstmeldung
            {item.pendingPayments.length === 1 ? "" : "en"} wartet auf Bestätigung
          </p>
          <ul className="space-y-1.5">
            {item.pendingPayments.map((p) => (
              <li key={p.transaction_id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-paper-soft px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <strong>{nameOf(p.person_id)}</strong> hat <strong className="text-primary">{formatEuro(p.amount)}</strong> gemeldet
                  <span className="block text-xs text-ink-soft">{formatDeDate(p.date)}</span>
                </div>
                {canRecord && <PendingActions transactionId={p.transaction_id} who={nameOf(p.person_id)} amount={formatEuro(p.amount)} />}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Matrix: je Person eine Zeile */}
      <ul className="mt-3 divide-y divide-rule rounded-md border border-rule text-sm" aria-label={`Zahlungsstatus pro Person für ${item.label}`}>
        {rows.map((c) => {
          const actionable = canRecord && c.soll > 0.005;
          const content = (
            <>
              <span className="min-w-0 flex-1 truncate text-left font-medium">
                {c.name}
                {c.person_id === item.payee_person_id && <span className="ml-1 text-xs font-normal text-ink-soft">(Empfänger)</span>}
              </span>
              <StatusBadge status={c.status} />
              <span className="w-32 shrink-0 text-right tabular-nums text-ink-soft">
                {formatEuro(c.paid)} / <span className="text-ink">{formatEuro(c.soll)}</span>
              </span>
            </>
          );
          return (
            <li key={c.person_id}>
              {actionable ? (
                <button
                  type="button"
                  onClick={() => onRecord(c)}
                  aria-label={itemCellAriaLabel({
                    name: c.name,
                    itemLabel: item.label,
                    status: c.status,
                    soll: c.soll,
                    paid: c.paid,
                    pending: c.pending,
                    fmt: formatEuro,
                    actionable: true,
                  })}
                  className="flex min-h-[44px] w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 hover:bg-navy-light/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30"
                >
                  {content}
                </button>
              ) : (
                <div
                  role="group"
                  aria-label={itemCellAriaLabel({
                    name: c.name,
                    itemLabel: item.label,
                    status: c.status,
                    soll: c.soll,
                    paid: c.paid,
                    pending: c.pending,
                    fmt: formatEuro,
                    actionable: false,
                  })}
                  className="flex min-h-[44px] flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
                >
                  {content}
                </div>
              )}
            </li>
          );
        })}
        {rows.length === 0 && <li className="px-3 py-3 text-ink-soft">Noch keine Sollbeträge hinterlegt.</li>}
      </ul>

      {canEdit && (
        <ItemAdminActions
          tripId={tripId}
          item={item}
          onEdit={onEdit}
          deleteReason={locks.deleteReason}
          lastNotifiedLabel={lastNotifiedLabel}
        />
      )}
    </article>
  );
}

function ItemAdminActions({
  tripId,
  item,
  onEdit,
  deleteReason,
  lastNotifiedLabel,
}: {
  tripId: string;
  item: PrepaymentItemView;
  onEdit: () => void;
  deleteReason: string | null;
  lastNotifiedLabel: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setError(null);
    const ok = await confirm({
      title: `Posten „${item.label}“ löschen?`,
      body: "Der Posten und sein Soll werden entfernt. Das lässt sich nicht rückgängig machen.",
      confirmLabel: "Löschen",
      danger: true,
    });
    if (!ok) return;
    const fd = new FormData();
    fd.set("trip_id", tripId);
    fd.set("item_id", item.id);
    startTransition(async () => {
      let res: ItemActionState;
      try {
        res = await deleteItem({ status: "idle" }, fd);
      } catch {
        setError(NETWORK_ERROR_MESSAGE);
        return;
      }
      if (res.status === "error") {
        setError(res.message);
        return;
      }
      toast.show("Posten gelöscht.", { variant: "success" });
      router.refresh();
    });
  }

  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex min-h-[44px] items-center gap-1 rounded-md border border-rule px-3 py-2 text-sm hover:border-primary/40 hover:bg-navy-light/20 focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          <Pencil className="h-4 w-4" aria-hidden="true" />
          Bearbeiten
        </button>
        <button
          type="button"
          onClick={() => {
            if (!pending && deleteReason === null) void remove();
          }}
          // aria-disabled statt disabled: bleibt fokussierbar, die Begründung wird vorgelesen.
          aria-disabled={pending || deleteReason !== null}
          aria-describedby={deleteReason ? `item-${item.id}-del` : undefined}
          className={`inline-flex min-h-[44px] items-center gap-1 rounded-md border border-rule px-3 py-2 text-sm text-danger hover:border-danger/40 focus:outline-none focus:ring-2 focus:ring-danger/30 ${
            pending || deleteReason !== null ? "cursor-not-allowed opacity-50" : ""
          }`}
        >
          {pending ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Trash2 className="h-4 w-4" aria-hidden="true" />}
          Löschen
        </button>
        {/* Update-Mail nach Änderungen (PR6); beim Anlegen geht die Mail automatisch raus. */}
        <NotifyCrewButton tripId={tripId} itemId={item.id} subject={`„${item.label}“`} lastNotifiedLabel={lastNotifiedLabel} />
      </div>
      {deleteReason && (
        <p id={`item-${item.id}-del`} className="mt-2 text-xs text-ink-soft">{deleteReason}</p>
      )}
      {error && (
        <p role="alert" className="mt-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>
      )}
      {confirmDialog}
    </div>
  );
}

function PendingActions({ transactionId, who, amount }: { transactionId: string; who: string; amount: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(action: typeof confirmItemSelfPayment, okMessage: string) {
    setError(null);
    const fd = new FormData();
    fd.set("transaction_id", transactionId);
    startTransition(async () => {
      let res: ItemActionState;
      try {
        res = await action({ status: "idle" }, fd);
      } catch {
        setError(NETWORK_ERROR_MESSAGE);
        return;
      }
      if (res.status === "error") {
        setError(res.message);
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
          onClick={() => run(confirmItemSelfPayment, "Zahlung bestätigt.")}
          disabled={pending}
          aria-label={`Meldung von ${who} über ${amount} bestätigen`}
          title="Bestätigen"
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md bg-success px-3 py-1.5 text-paper hover:bg-success/90 focus:outline-none focus:ring-2 focus:ring-success/40 disabled:opacity-50"
        >
          {pending ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
        </button>
        <button
          type="button"
          onClick={() => run(rejectItemSelfPayment, "Meldung abgelehnt.")}
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

// ────────────────────────────────────────────────────────────────────────
// Crew-Sicht: nur die eigene Zeile
// ────────────────────────────────────────────────────────────────────────

function ItemSelfCard({
  item,
  viewerId,
  payeeName,
  readOnly,
  onReport,
}: {
  item: PrepaymentItemView;
  viewerId: string | null;
  payeeName: string;
  readOnly: boolean;
  onReport: (cell: PrepaymentItemView["cells"][number]) => void;
}) {
  const mine = item.cells.find((c) => c.person_id === viewerId);
  if (!mine) return null;
  const open = Math.max(0, mine.soll - mine.paid);
  const canReport = !readOnly && open > 0.005 && mine.pending <= 0.005;
  // Frist + Erinnerungshinweis nur, solange wirklich etwas offen ist (nicht
  // bezahlt, nicht gemeldet, nicht archiviert) — sonst „wandert" die
  // geclampte Crewfrist täglich mit, obwohl nichts mehr zu tun ist.
  const showDue = canReport && !!item.due_date;

  return (
    <article aria-labelledby={`item-${item.id}-h`} className="rounded-lg border border-rule bg-paper p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <CategoryIcon icon={item.category_icon} name={item.category_name} className="h-5 w-5 shrink-0 text-primary" />
          <h3 id={`item-${item.id}-h`} className="min-w-0 truncate text-base font-semibold text-ink">{item.label}</h3>
        </div>
        <StatusBadge status={mine.status} />
      </div>
      <p className="mt-1 text-xs text-ink-soft">
        Zahlung an <strong className="text-ink">{payeeName}</strong>
        {showDue && <> · bitte zahlen bis {formatDeDate(toCrewDueDate(item.due_date!))}</>}
      </p>
      <dl className="mt-3 grid grid-cols-3 gap-2 rounded-md bg-paper-soft p-3 text-sm">
        <div><dt className="text-xs text-ink-soft">Dein Soll</dt><dd className="font-medium tabular-nums">{formatEuro(mine.soll)}</dd></div>
        <div><dt className="text-xs text-ink-soft">Bezahlt</dt><dd className="font-medium tabular-nums">{formatEuro(mine.paid)}</dd></div>
        <div><dt className="text-xs text-ink-soft">Offen</dt><dd className="font-medium tabular-nums">{formatEuro(open)}</dd></div>
      </dl>
      {mine.pending > 0.005 && (
        <p role="status" className="mt-2 rounded-md bg-paper-soft px-3 py-2 text-xs text-ink-soft">
          <span aria-hidden="true">⏳</span> Du hast <strong>{formatEuro(mine.pending)}</strong> gemeldet — {payeeName} muss das noch bestätigen.
        </p>
      )}
      {mine.status === "overpaid" && (
        <p role="note" className="mt-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
          Du hast {formatEuro(mine.paid - mine.soll)} zu viel bezahlt. Sprich bitte mit {payeeName} über die Rückzahlung.
        </p>
      )}
      {canReport && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => onReport(mine)}
            className="inline-flex min-h-[44px] items-center gap-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-paper hover:bg-navy-dark focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Ich habe gezahlt
          </button>
        </div>
      )}
      {canReport && (
        <p className="mt-3 text-xs text-ink-soft">
          {item.due_date
            ? "Ist dein Anteil 3 Tage vor dieser Frist noch offen, bekommst du eine Erinnerung per Mail."
            : "Für diesen Posten ist keine Fälligkeit hinterlegt, daher gibt es keine automatische Erinnerung."}
        </p>
      )}
    </article>
  );
}
