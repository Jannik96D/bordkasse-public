"use client";

import { useActionState, useCallback, useEffect, useState, useTransition } from "react";
import { Anchor, ArrowRightLeft, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  inviteMember,
  removeMember,
  setSkipperRole,
  updateMember,
  type MemberState,
} from "@/lib/actions/trip-members";
import { replaceMember, type PrepaymentState } from "@/lib/actions/prepayments";
import type { TripMemberRow } from "@/lib/queries/trips";
import { formatDate } from "@/lib/utils";
import { tripVocab, type TripType, type TripVocab } from "@/lib/trip-vocab";
import { InfoTooltip } from "@/components/info-tooltip";
import { useConfirm } from "@/components/confirm-dialog";

const initial: MemberState = { status: "idle" };
const replaceInitial: PrepaymentState = { status: "idle" };

export function CrewSection({
  tripId,
  members,
  canEdit,
  ownerId,
  startDate,
  endDate,
  tripType = "sailing",
}: {
  tripId: string;
  members: TripMemberRow[];
  canEdit: boolean;
  ownerId: string;
  startDate: string;
  endDate: string;
  tripType?: TripType;
}) {
  const vocab = tripVocab(tripType);
  const [showForm, setShowForm] = useState(members.length === 0);
  const [, startTransition] = useTransition();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [replacingId, setReplacingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();
  const closeAddForm = useCallback(() => setShowForm(false), []);

  const handleRemove = async (m: TripMemberRow) => {
    if (m.person_id === ownerId) return;
    const ok = await confirm({
      title: `${m.display_name} aus der ${vocab.crew} entfernen?`,
      body: `Die Person wird von ${vocab.trip === "Reise" ? "dieser Reise" : "diesem Törn"} entfernt. Bereits erfasste Buchungen müssen vorher umgebucht sein.`,
      confirmLabel: "Entfernen",
      danger: true,
    });
    if (!ok) return;
    startTransition(async () => {
      setRemoveError(null);
      const res = await removeMember(m.id, tripId);
      if (!res.ok) {
        setRemoveError(`${m.display_name}: ${res.message}`);
      }
    });
  };

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-primary">{vocab.crew}</h2>
        {canEdit && !showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-paper hover:bg-navy-dark"
          >
            <Plus className="h-4 w-4" /> Hinzufügen
          </button>
        )}
      </div>

      {members.length === 0 && !showForm && (
        <p className="rounded-md border border-dashed border-rule p-4 text-center text-sm text-ink-soft">
          Keine {vocab.crew} angelegt.
        </p>
      )}

      {removeError && (
        <div
          role="alert"
          className="mb-3 flex items-start justify-between gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger"
        >
          <span>{removeError}</span>
          <button
            type="button"
            onClick={() => setRemoveError(null)}
            className="text-danger/70 hover:text-danger"
            aria-label="Schließen"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <ul className="space-y-2">
        {members.map((m) => (
          <li
            key={m.id}
            className="rounded-md border border-rule bg-paper"
          >
            <div className="flex items-start justify-between gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  <span>{m.display_name}</span>
                  {m.is_skipper && (
                    <span
                      className="inline-flex items-center gap-1 rounded-full bg-navy-light/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary"
                      title={m.person_id === ownerId ? `Original-${vocab.skipper}` : vocab.coSkipper}
                    >
                      <Anchor className="h-3 w-3" />
                      {m.person_id === ownerId ? vocab.skipper : vocab.coSkipper}
                    </span>
                  )}
                  {m.is_alcoholic_effective && (
                    <span className="rounded-full bg-navy-light px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                      🍷
                    </span>
                  )}
                </p>
                {m.email && <p className="text-xs text-ink-soft">{m.email}</p>}
                {/* An-Bordzeile NUR rendern, wenn die Anwesenheit vom
                    Default („ganzer Törn") abweicht. Bei 5 Personen, die
                    alle den ganzen Trip dabei sind, spart das 5 redundante
                    Zeilen — der Default ist die Annahme, Abweichungen sind
                    der Hinweis. */}
                {(m.on_board_from || m.on_board_to) && (
                  <p className="mt-1 text-xs text-ink-soft">
                    {vocab.onBoard}:{" "}
                    {m.on_board_from ? formatDate(m.on_board_from) : `ab ${vocab.tripStart}`}
                    {" – "}
                    {m.on_board_to ? formatDate(m.on_board_to) : "bis Ende"}
                  </p>
                )}
                {m.note && (
                  <p className="mt-1 text-xs italic text-ink-soft">„{m.note}“</p>
                )}
              </div>
              {canEdit && (
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      startTransition(() => {
                        setSkipperRole(m.id, tripId, !m.is_skipper);
                      });
                    }}
                    disabled={m.person_id === ownerId}
                    className={
                      m.is_skipper
                        ? "rounded-md p-1.5 text-primary hover:bg-paper-soft disabled:cursor-not-allowed disabled:opacity-40"
                        : "rounded-md p-1.5 text-ink-soft hover:bg-paper-soft hover:text-primary"
                    }
                    aria-label={
                      m.is_skipper
                        ? `${vocab.skipper}rechte für ${m.display_name} entziehen`
                        : `${m.display_name} zum ${vocab.skipper} machen`
                    }
                    title={
                      m.person_id === ownerId
                        ? `Der Original-${vocab.skipper} kann nicht degradiert werden.`
                        : m.is_skipper
                          ? `${vocab.skipper}rechte entziehen`
                          : `Zum ${vocab.coSkipper} machen`
                    }
                  >
                    <Anchor className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setReplacingId(null);
                      setEditingId(editingId === m.id ? null : m.id);
                    }}
                    className="rounded-md p-1.5 text-ink-soft hover:bg-paper-soft hover:text-primary"
                    aria-label={`${m.display_name} bearbeiten`}
                    title="Bearbeiten"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(null);
                      setReplacingId(replacingId === m.id ? null : m.id);
                    }}
                    disabled={m.person_id === ownerId}
                    className="rounded-md p-1.5 text-ink-soft hover:bg-paper-soft hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label={`${m.display_name} durch eine andere Person ersetzen`}
                    title={
                      m.person_id === ownerId
                        ? `Der Original-${vocab.skipper} kann nicht ersetzt werden.`
                        : "Durch eine andere Person ersetzen"
                    }
                  >
                    <ArrowRightLeft className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemove(m)}
                    disabled={m.person_id === ownerId}
                    className="rounded-md p-1.5 text-ink-soft hover:bg-paper-soft hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label={`${m.display_name} entfernen`}
                    title={
                      m.person_id === ownerId
                        ? `Der Original-${vocab.skipper} kann nicht entfernt werden.`
                        : "Entfernen"
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>

            {canEdit && editingId === m.id && (
              <EditMemberForm
                member={m}
                tripId={tripId}
                startDate={startDate}
                endDate={endDate}
                vocab={vocab}
                onClose={() => setEditingId(null)}
              />
            )}
            {canEdit && replacingId === m.id && (
              <ReplaceMemberForm
                member={m}
                tripId={tripId}
                vocab={vocab}
                onClose={() => setReplacingId(null)}
              />
            )}
          </li>
        ))}
      </ul>

      {showForm && canEdit && (
        <AddMemberForm
          tripId={tripId}
          startDate={startDate}
          endDate={endDate}
          vocab={vocab}
          onClose={closeAddForm}
        />
      )}
      {confirmDialog}
    </section>
  );
}

/**
 * Hinzufügen-Maske als eigene Komponente, damit ihr useActionState beim
 * Zuklappen mit unmountet. useActionState hat keinen Reset — lebte der Hook
 * in CrewSection (immer gemountet), überlebte der „ok"-Status das Zuklappen
 * und die leere Maske zeigte beim nächsten Öffnen wieder „✓ Hinzugefügt.".
 */
function AddMemberForm({
  tripId,
  startDate,
  endDate,
  vocab,
  onClose,
}: {
  tripId: string;
  startDate: string;
  endDate: string;
  vocab: TripVocab;
  onClose: () => void;
}) {
  const [state, formAction, pending] = useActionState(inviteMember, initial);

  // Nach reinem Erfolg kurz „✓ Hinzugefügt." zeigen, dann zuklappen. Bei einer
  // Warnung (z.B. Einladungs-Mail fehlgeschlagen) bleibt die Maske offen, bis
  // der User sie selbst schließt — in 800 ms ist die Warnung nicht lesbar.
  useEffect(() => {
    if (state.status !== "ok" || state.warning) return;
    const t = setTimeout(onClose, 800);
    return () => clearTimeout(t);
  }, [state, onClose]);

  return (
    <form
      action={formAction}
      className="mt-4 space-y-3 rounded-md border border-rule bg-paper-soft p-4"
    >
      <div className="flex items-center justify-between">
        <h3 className="font-medium">{vocab.addMember}</h3>
        <button
          type="button"
          onClick={onClose}
          className="text-ink-soft hover:text-ink"
          aria-label="Abbrechen"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <input type="hidden" name="trip_id" value={tripId} />

      <div>
        <label htmlFor="email" className="block text-sm font-medium">
          E-Mail <span className="text-ink-soft font-normal">(optional)</span>
          <InfoTooltip
            label="Was passiert ohne E-Mail?"
            text="Ohne E-Mail wird die Person als Ghost angelegt: Kein Login, aber Anzahlungssoll und Buchungsbeteiligung funktionieren trotzdem. E-Mail später nachtragbar."
          />
        </label>
        <input id="email" name="email" type="email"
          placeholder="crew@example.com"
          className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
      </div>

      <div>
        <label htmlFor="display_name" className="block text-sm font-medium">
          Anzeigename
        </label>
        <input id="display_name" name="display_name" type="text"
          placeholder="Pflicht wenn keine E-Mail angegeben"
          className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
      </div>

      <div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="on_board_from" className="block text-xs font-medium">
              {vocab.onBoard} ab
            </label>
            <input id="on_board_from" name="on_board_from" type="date"
              min={startDate} max={endDate}
              placeholder={startDate}
              className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div>
            <label htmlFor="on_board_to" className="block text-xs font-medium">
              {vocab.onBoard} bis
            </label>
            <input id="on_board_to" name="on_board_to" type="date"
              min={startDate} max={endDate}
              placeholder={endDate}
              className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>
        </div>
        <p className="mt-1 text-xs text-ink-soft">
          Leer lassen für volle {vocab.trip}dauer ({formatDate(startDate)} – {formatDate(endDate)}).
        </p>
      </div>

      <div>
        <label htmlFor="is_alcoholic" className="block text-sm font-medium">
          Trinkt Alkohol mit?
          <InfoTooltip
            label="Was bewirkt das?"
            text="Legt fest, ob diese Person den Alkoholanteil einer Ausgabe mitträgt. „Default aus Person“ übernimmt die Voreinstellung aus dem Profil der Person."
          />
        </label>
        <select id="is_alcoholic" name="is_alcoholic"
          defaultValue=""
          className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        >
          <option value="">Default aus Person übernehmen</option>
          <option value="yes">Ja, bekommt Alkoholanteil</option>
          <option value="no">Nein, kein Alkoholanteil</option>
        </select>
      </div>

      <div>
        <label htmlFor="note" className="block text-sm font-medium">
          Hinweis <span className="text-ink-soft font-normal">(optional)</span>
        </label>
        <input id="note" name="note" type="text" maxLength={200}
          className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
      </div>

      {state.status === "error" && (
        <p className="text-sm text-danger" role="alert">{state.message}</p>
      )}
      {state.status === "ok" && (
        state.warning ? (
          <p
            className="rounded-md border border-gold/30 bg-gold-soft px-3 py-2 text-sm text-ink"
            role="status"
          >
            ⚠ {state.warning}
          </p>
        ) : (
          <p className="text-sm text-success" role="status">✓ Hinzugefügt.</p>
        )
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-primary px-4 py-2 font-medium text-paper hover:bg-navy-dark disabled:opacity-60"
      >
        {pending ? "Speichere …" : "Hinzufügen"}
      </button>
    </form>
  );
}

/**
 * Inline-Edit-Form, die unter einem ausgewählten Creweintrag erscheint.
 * Email + Name sind nur editierbar, wenn die Person noch keinen Auth-User hat
 * (Ghost) — sonst würden wir das globale Profil eines aktiven Users überschreiben.
 */
function EditMemberForm({
  member,
  tripId,
  startDate,
  endDate,
  vocab,
  onClose,
}: {
  member: TripMemberRow;
  tripId: string;
  startDate: string;
  endDate: string;
  vocab: TripVocab;
  onClose: () => void;
}) {
  const [state, formAction, pending] = useActionState(updateMember, initial);
  if (state.status === "ok") {
    setTimeout(onClose, 600);
  }

  return (
    <form
      action={formAction}
      className="space-y-3 border-t border-rule bg-paper-soft p-4"
    >
      <input type="hidden" name="member_id" value={member.id} />
      <input type="hidden" name="trip_id" value={tripId} />

      <div className="flex items-center justify-between">
        <h4 className="font-medium">{member.display_name} bearbeiten</h4>
        <button
          type="button"
          onClick={onClose}
          className="text-ink-soft hover:text-ink"
          aria-label="Abbrechen"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div>
        <label htmlFor={`name-${member.id}`} className="block text-sm font-medium">
          Anzeigename
          {!member.is_ghost && (
            <span className="ml-2 text-xs font-normal text-ink-soft">
              (gesperrt, Person verwaltet ihren Namen selbst)
            </span>
          )}
        </label>
        <input
          id={`name-${member.id}`}
          name="display_name"
          type="text"
          defaultValue={member.is_ghost ? member.display_name : ""}
          disabled={!member.is_ghost}
          placeholder={member.is_ghost ? undefined : member.display_name}
          className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:bg-paper-soft disabled:text-ink-soft"
        />
      </div>

      <div>
        <label htmlFor={`email-${member.id}`} className="block text-sm font-medium">
          E-Mail
          {!member.is_ghost && (
            <span className="ml-2 text-xs font-normal text-ink-soft">
              (gesperrt, User ist eingeloggt)
            </span>
          )}
        </label>
        <input
          id={`email-${member.id}`}
          name="email"
          type="email"
          defaultValue={member.is_ghost ? member.email ?? "" : ""}
          disabled={!member.is_ghost}
          placeholder={member.is_ghost ? undefined : member.email ?? ""}
          className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:bg-paper-soft disabled:text-ink-soft"
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor={`from-${member.id}`} className="block text-xs font-medium">
            {vocab.onBoard} ab
          </label>
          <input
            id={`from-${member.id}`}
            name="on_board_from"
            type="date"
            min={startDate}
            max={endDate}
            defaultValue={member.on_board_from ?? ""}
            className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </div>
        <div>
          <label htmlFor={`to-${member.id}`} className="block text-xs font-medium">
            {vocab.onBoard} bis
          </label>
          <input
            id={`to-${member.id}`}
            name="on_board_to"
            type="date"
            min={startDate}
            max={endDate}
            defaultValue={member.on_board_to ?? ""}
            className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </div>
      </div>

      <div>
        <label htmlFor={`alc-${member.id}`} className="block text-sm font-medium">
          Trinkt Alkohol mit?
        </label>
        <select
          id={`alc-${member.id}`}
          name="is_alcoholic"
          defaultValue={
            member.is_alcoholic_override === true
              ? "yes"
              : member.is_alcoholic_override === false
                ? "no"
                : ""
          }
          className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        >
          <option value="">Default aus Person übernehmen</option>
          <option value="yes">Ja, bekommt Alkoholanteil</option>
          <option value="no">Nein, kein Alkoholanteil</option>
        </select>
      </div>

      <div>
        <label htmlFor={`note-${member.id}`} className="block text-sm font-medium">
          Hinweis <span className="text-ink-soft font-normal">(optional)</span>
        </label>
        <input
          id={`note-${member.id}`}
          name="note"
          type="text"
          maxLength={200}
          defaultValue={member.note ?? ""}
          className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
      </div>

      {state.status === "error" && (
        <p className="text-sm text-danger" role="alert">{state.message}</p>
      )}
      {state.status === "ok" && (
        <p className="text-sm text-success" role="status">✓ Gespeichert.</p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-primary px-4 py-2 font-medium text-paper hover:bg-navy-dark disabled:opacity-60"
      >
        {pending ? "Speichere …" : "Speichern"}
      </button>
    </form>
  );
}

/**
 * Crewwechsel: A (member) wird durch eine neue Person B ersetzt. Übernimmt
 * Anwesenheit/Koje/Anzahlungssoll von A, bucht bereits geleistete
 * Anzahlungszahlungen von A auf B um (Gegen-Gutschrift) und setzt A's
 * Anwesenheit auf null (bleibt im Audit-Trail, wird aber nicht mehr zur
 * Kasse gebeten). Löst das Remove-Schutz-Dilemma: eine Person mit
 * Buchungen/Anzahlungssoll kann nicht einfach entfernt werden, aber ein
 * Crewwechsel (z.B. Person sagt ab, jemand anderes rückt nach) ist ein
 * eigener, häufiger Fall.
 */
function ReplaceMemberForm({
  member,
  tripId,
  vocab,
  onClose,
}: {
  member: TripMemberRow;
  tripId: string;
  vocab: TripVocab;
  onClose: () => void;
}) {
  const [state, formAction, pending] = useActionState(replaceMember, replaceInitial);

  useEffect(() => {
    if (state.status !== "ok") return;
    const t = setTimeout(onClose, 1000);
    return () => clearTimeout(t);
  }, [state, onClose]);

  return (
    <form
      action={formAction}
      className="space-y-3 border-t border-rule bg-paper-soft p-4"
    >
      <input type="hidden" name="trip_id" value={tripId} />
      <input type="hidden" name="old_person_id" value={member.person_id} />

      <div className="flex items-center justify-between">
        <h4 className="font-medium">
          {member.display_name} ersetzen
          <InfoTooltip
            label="Was passiert dabei?"
            text={`Anwesenheit, ${vocab.cabin} und Anzahlungssoll von ${member.display_name} gehen auf die neue Person über. Bereits geleistete Anzahlungszahlungen werden auf die neue Person umgebucht. ${member.display_name} bleibt im Audit-Trail sichtbar, gilt aber ab jetzt als nicht mehr ${vocab.onBoard.toLowerCase()}.`}
          />
        </h4>
        <button
          type="button"
          onClick={onClose}
          className="text-ink-soft hover:text-ink"
          aria-label="Abbrechen"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div>
        <label htmlFor={`repl-email-${member.id}`} className="block text-sm font-medium">
          E-Mail der neuen Person <span className="text-ink-soft font-normal">(optional)</span>
        </label>
        <input
          id={`repl-email-${member.id}`}
          name="new_email"
          type="email"
          placeholder="crew@example.com"
          className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
      </div>

      <div>
        <label htmlFor={`repl-name-${member.id}`} className="block text-sm font-medium">
          Anzeigename der neuen Person
        </label>
        <input
          id={`repl-name-${member.id}`}
          name="new_display_name"
          type="text"
          placeholder="Pflicht wenn keine E-Mail angegeben"
          className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
      </div>

      {state.status === "error" && (
        <p className="text-sm text-danger" role="alert">{state.message}</p>
      )}
      {state.status === "ok" && (
        <p className="text-sm text-success" role="status">✓ Ersetzt.</p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-primary px-4 py-2 font-medium text-paper hover:bg-navy-dark disabled:opacity-60"
      >
        {pending ? "Speichere …" : "Ersetzen"}
      </button>
    </form>
  );
}
