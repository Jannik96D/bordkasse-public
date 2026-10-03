"use client";

/**
 * „Weitere Zahlungen" (Migration 0058, PR4b; PR7 umbenannt + vereinheitlicht)
 * — Sektion auf der Anzahlungs-Seite, unter der Karte des Anzahlungsplans.
 *
 * Intern heißt eine weitere Zahlung `item` (Tabelle `prepayment_items`); in
 * Nutzertexten gibt es das Wort „Posten" nicht mehr.
 *
 * Eine weitere Zahlung ist ein eigener Topf neben der Yachtanzahlung (z. B.
 * Flüge für die An-/Abreise). Pro Karte gibt es zwei Sichten, je nach Rolle:
 *   • ItemCard     — Skipper/Admin und die vorstreckende Person: alle
 *     Personen mit Status, Meldungen bestätigen/ablehnen, Einzahlungen
 *     erfassen, Überweisung an den Anbieter, (Skipper/Admin) bearbeiten/löschen.
 *   • ItemSelfCard — übrige Crew: nur die eigene Zeile + „Ich habe gezahlt".
 * Die Rolle wird serverseitig in jeder Action erneut geprüft; die Sicht hier
 * blendet nur aus, was ohnehin abgelehnt würde. Aufbau der Karte = Aufbau der
 * Plan-Karte (payment-card-parts.tsx).
 *
 * Automatische Erinnerungen (PR5): der tägliche Anzahlungs-Cron erinnert die
 * Crew ab 6 Tagen vor der Fälligkeit beim Anbieter (= 3 Tage vor der
 * Crewfrist) und die vorstreckende Person ab 3 Tagen davor — der Hinweis
 * steht sichtbar in der Sektion. Ohne Fälligkeit gibt es keine Erinnerung.
 */

import { useState } from "react";
import { Plus, Info } from "lucide-react";
import { CategoryIcon } from "@/components/category-icon";
import { InfoTooltip } from "@/components/info-tooltip";
import { useTripVocab } from "@/components/trip-vocab-provider";
import { formatEuro } from "@/lib/utils";
import { formatDeDate, toCrewDueDate } from "@/lib/prepayments/dates";
import {
  groupPaidCapped,
  itemOverallStatus,
  itemsVisibleTo,
  providerDueInfo,
} from "@/lib/prepayments/item-ui";
import { ACTION_RECORD, ACTION_REPORT, LABEL_PROVIDER_PAID, NOUN_ITEM, NOUN_ITEMS } from "@/lib/prepayments/payment-words";
import {
  confirmItemSelfPayment,
  rejectItemSelfPayment,
} from "@/lib/actions/prepayment-items";
import type { PrepaymentItemView } from "@/lib/queries/prepayment-items";
import { sendItemReminder } from "@/lib/actions/prepayment-item-reminder";
import { PersonStatusList } from "./person-status-list";
import { buildPersonRow, summarizeRows, visiblePersonRows } from "@/lib/prepayments/person-rows";
import { ItemFormModal } from "./item-form-modal";
import { ItemPaymentModal, ItemProviderPaymentModal } from "./item-payment-modals";
import { NotifyCrewButton } from "./notify-crew-button";
import {
  EditButton,
  OverpaidNote,
  PaymentActionBar,
  PaymentSummaryLine,
  PendingReportsBanner,
  ReminderBell,
  PaymentCardHeader,
  PaymentProgress,
  ProviderOpenBlock,
} from "./payment-card-parts";

interface Member {
  id: string;
  display_name: string;
  /** Für die Erinnerungs-Glocke: ohne E-Mail keine Mail. */
  hasEmail?: boolean;
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
  /** Skipper/Admin: weitere Zahlungen anlegen/bearbeiten/löschen, alles sehen. */
  canManageItems: boolean;
  /** Archivierte Törns sind schreibgeschützt (assertTripNotArchived). */
  readOnly: boolean;
  /** Vorbelegung der vorstreckenden Person beim Anlegen (Trip-Skipper). */
  defaultPayeeId: string | null;
  /** Heutiges Datum (ISO), vom Server — Server und Client rechnen damit identisch (kein Hydration-Mismatch). */
  today: string;
  /** Letzter Versand „Crew informieren" je weiterer Zahlung, server-seitig formatiert (PR6, fail-soft leer). */
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
  // Aktueller Stand der offenen Modale; verschwindet die Karte (anderswo gelöscht), schließt das Modal.
  const formItem = form?.itemId ? itemById.get(form.itemId) ?? null : null;
  const paymentItem = payment ? itemById.get(payment.itemId) ?? null : null;
  const paymentCell = payment && paymentItem ? paymentItem.cells.find((c) => c.person_id === payment.personId) : undefined;
  const provider = providerId ? itemById.get(providerId) ?? null : null;
  const nameById = new Map(members.map((m) => [m.id, m.display_name]));
  const nameOf = (id: string) => nameById.get(id) ?? vocab.member;

  // Crew sieht nur Karten, an denen sie beteiligt ist (Soll/Zahlung/vorstreckende Person).
  const visible = canManageItems ? items : itemsVisibleTo(items, viewerId);

  if (visible.length === 0 && !canManageItems) return null;

  return (
    <section className="mt-8" aria-labelledby="items-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="items-heading" className="text-lg font-bold text-primary">{NOUN_ITEMS}</h2>
        {canManageItems && !readOnly && (
          <button
            type="button"
            onClick={() => setForm({ itemId: null })}
            className="inline-flex min-h-[44px] items-center gap-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-paper hover:bg-navy-dark focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {NOUN_ITEM} hinzufügen
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-ink-soft">
        Zahlungen neben der {vocab.prepayment}, z. B. Flüge oder Bahn für die An-/Abreise: Eine Person streckt vor,
        zahlt vorab an den Anbieter und bekommt das Geld von der {vocab.crew} zurück.
      </p>
      {(canManageItems || visible.some((it) => it.payee_person_id === viewerId)) && (
        <p className="mt-2 flex items-start gap-2 rounded-md bg-paper-soft px-3 py-2 text-xs text-ink-soft">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span>
            Automatische Erinnerungen: Wer noch nicht gezahlt hat, bekommt 6 Tage vor der Fälligkeit beim Anbieter eine
            Mail (die {vocab.crew} soll 3 Tage vor dieser Fälligkeit zahlen). Die vorstreckende Person bekommt 3 Tage
            vorher eine Übersicht, solange der Anbieter noch nicht voll bezahlt ist. Ohne Fälligkeit gibt es keine
            Erinnerung.
            {canManageItems && (
              <>
                {" "}Beim Anlegen bekommen alle mit Anteil automatisch eine Mail; nach einer Änderung informierst du
                sie über „{vocab.crew} informieren“.
              </>
            )}
          </span>
        </p>
      )}
      {readOnly && (
        <p role="note" className="mt-2 rounded-md bg-paper-soft px-3 py-2 text-xs text-ink-soft">
          Dieser {vocab.trip} ist archiviert — weitere Zahlungen sind schreibgeschützt.
        </p>
      )}

      {visible.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-primary/30 bg-navy-light/30 p-5 text-center text-sm text-ink-soft">
          Noch keine weiteren Zahlungen angelegt.
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
                    hasEmail={(id) => members.find((m) => m.id === id)?.hasEmail !== false}
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

// ────────────────────────────────────────────────────────────────────────
// Vollansicht (Skipper/Admin/vorstreckende Person)
// ────────────────────────────────────────────────────────────────────────

function ItemCard({
  tripId,
  item,
  payeeName,
  nameOf,
  hasEmail,
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
  hasEmail: (id: string) => boolean;
  canEdit: boolean;
  canRecord: boolean;
  today: string;
  onEdit: () => void;
  lastNotifiedLabel: string | null;
  onRecord: (cell: PrepaymentItemView["cells"][number]) => void;
  onProvider: () => void;
}) {
  const vocab = useTripVocab();
  const overall = itemOverallStatus(item);
  const due = providerDueInfo(item, today, formatDeDate);
  const personRows = visiblePersonRows(
    item.cells.map((c) =>
      buildPersonRow({
        key: c.person_id,
        name: nameOf(c.person_id),
        badge: c.person_id === item.payee_person_id ? "Streckt vor" : null,
        allowWhilePending: true,
        rates: [{ key: item.id, label: item.label, detail: "", soll: c.soll, paid: c.paid, pending: c.pending, overdue: false }],
      }),
    ),
  );
  const summary = summarizeRows(personRows);
  const runPending = (action: typeof confirmItemSelfPayment | typeof rejectItemSelfPayment, id: string) => {
    const fd = new FormData();
    fd.set("transaction_id", id);
    return action({ status: "idle" }, fd);
  };

  return (
    <article aria-labelledby={`item-${item.id}-h`} className="rounded-lg border border-rule bg-paper p-4">
      <PaymentCardHeader
        icon={<CategoryIcon icon={item.category_icon} name={item.category_name} className="h-5 w-5 shrink-0 text-primary" />}
        title={item.label}
        titleId={`item-${item.id}-h`}
        amount={item.total_amount}
        meta={
          <>
            {item.category_name && <span>{item.category_name}</span>}
            {item.due_date && <span>· Fällig {formatDeDate(item.due_date)}</span>}
          </>
        }
        advancerName={payeeName}
        overall={overall}
      />

      <div className="mt-3 space-y-3">
        <PaymentProgress label={`Von der ${vocab.crew} bezahlt`} done={groupPaidCapped(item.cells)} total={item.sollTotal} />
        <PaymentProgress
          label={LABEL_PROVIDER_PAID}
          done={Math.min(item.providerPaid, item.total_amount)}
          total={item.total_amount}
          tone={item.providerPaid > item.total_amount + 0.005 ? "warn" : undefined}
        />
      </div>

      <PaymentSummaryLine summary={summary} pendingCount={item.pendingPayments.length} />
      <OverpaidNote amount={summary.overpaidTotal} />

      <ProviderOpenBlock open={item.providerOpen} due={due} action={canRecord ? { onClick: onProvider } : null} />

      <PendingReportsBanner
        entries={item.pendingPayments.map((p) => ({ id: p.transaction_id, who: nameOf(p.person_id), amount: p.amount, date: p.date }))}
        ariaSubject={item.label}
        confirm={canRecord ? (id) => runPending(confirmItemSelfPayment, id) : undefined}
        reject={canRecord ? (id) => runPending(rejectItemSelfPayment, id) : undefined}
      />

      {/* Personenliste: je Person eine Zeile, Knopf „Einzahlung erfassen“ daneben */}
      <div className="mt-3">
        <PersonStatusList
          rows={personRows}
          ariaLabel={`Zahlungsstatus pro Person für ${item.label}`}
          actionLabel={ACTION_RECORD}
          contextLabel={item.label}
          onAct={canRecord ? (personId) => { const c = item.cells.find((x) => x.person_id === personId); if (c) onRecord(c); } : undefined}
          renderExtras={canRecord ? (row) => {
            const isPayee = row.key === item.payee_person_id;
            const nothingOpen = isPayee ? item.providerOpen <= 0.005 : row.open <= 0.005;
            const title = !hasEmail(row.key)
              ? "E-Mail fehlt"
              : !item.due_date
                ? "Ohne Frist keine Erinnerung — bitte zuerst eine Frist eintragen"
                : nothingOpen
                  ? isPayee ? "Alles an den Anbieter überwiesen, keine Erinnerung nötig" : "Nichts offen"
                  : isPayee ? `Übersicht an ${row.name} schicken (noch an den Anbieter zu überweisen)` : `Erinnerungsmail an ${row.name}`;
            return (
              <ReminderBell
                onSend={() => {
                  const fd = new FormData();
                  fd.set("trip_id", tripId);
                  fd.set("item_id", item.id);
                  fd.set("person_id", row.key);
                  return sendItemReminder({ status: "idle" }, fd);
                }}
                disabled={!hasEmail(row.key) || !item.due_date || nothingOpen}
                title={title}
              />
            );
          } : undefined}
        />
      </div>

      <ItemActions
        tripId={tripId}
        item={item}
        canEdit={canEdit}
        onEdit={onEdit}
        lastNotifiedLabel={lastNotifiedLabel}
      />
    </article>
  );
}

/** Aktionsleiste in fester Reihenfolge: Einzahlung erfassen · Crew informieren · Bearbeiten · Löschen. */
function ItemActions({
  tripId,
  item,
  canEdit,
  onEdit,
  lastNotifiedLabel,
}: {
  tripId: string;
  item: PrepaymentItemView;
  canEdit: boolean;
  onEdit: () => void;
  lastNotifiedLabel: string | null;
}) {
  // Gleiche Leiste wie beim Anzahlungsplan; Löschen sitzt im Bearbeiten-Dialog.
  return (
    <PaymentActionBar
      // Update-Mail nach Änderungen (PR6); beim Anlegen geht die Mail automatisch raus.
      notify={canEdit ? <NotifyCrewButton tripId={tripId} itemId={item.id} subject={`„${item.label}“`} lastNotifiedLabel={lastNotifiedLabel} /> : null}
      edit={canEdit ? <EditButton onClick={onEdit} /> : null}
    />
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
  const selfRows = visiblePersonRows([
    buildPersonRow({
      key: mine.person_id,
      name: "Dein Anteil",
      allowWhilePending: false,
      rates: [{ key: item.id, label: item.label, detail: "", soll: mine.soll, paid: mine.paid, pending: mine.pending, overdue: false }],
    }),
  ]);

  return (
    <article aria-labelledby={`item-${item.id}-h`} className="rounded-lg border border-rule bg-paper p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <CategoryIcon icon={item.category_icon} name={item.category_name} className="h-5 w-5 shrink-0 text-primary" />
          <h3 id={`item-${item.id}-h`} className="min-w-0 truncate text-base font-semibold text-ink">{item.label}</h3>
        </div>
      </div>
      <p className="mt-1 text-xs text-ink-soft">
        Einzahlung an <strong className="text-ink">{payeeName}</strong> (streckt vor)
        {showDue && <> · bitte zahlen bis {formatDeDate(toCrewDueDate(item.due_date!))}</>}
        {canReport && (
          <InfoTooltip
            label="Erinnerung per Mail"
            text={
              item.due_date
                ? "Ist dein Anteil 3 Tage vor dieser Frist noch offen, bekommst du eine Erinnerung per Mail."
                : "Hier ist keine Fälligkeit hinterlegt, daher gibt es keine automatische Erinnerung."
            }
          />
        )}
      </p>
      <div className="mt-3">
        <PersonStatusList
          rows={selfRows}
          ariaLabel={`Dein Zahlungsstatus für ${item.label}`}
          actionLabel={ACTION_REPORT}
          contextLabel={item.label}
          onAct={canReport ? () => onReport(mine) : undefined}
        />
      </div>
      {mine.pending > 0.005 && (
        <p role="status" className="mt-2 rounded-md bg-paper-soft px-3 py-2 text-xs text-ink-soft">
          <span aria-hidden="true">⏳</span> Du hast <strong>{formatEuro(mine.pending)}</strong> gemeldet — wartet auf Bestätigung durch {payeeName}.
        </p>
      )}
      {mine.status === "overpaid" && (
        <p role="note" className="mt-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
          Du hast {formatEuro(mine.paid - mine.soll)} zu viel bezahlt. Sprich bitte mit {payeeName} über die Rückzahlung.
        </p>
      )}
    </article>
  );
}
