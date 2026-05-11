"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { Anchor, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  inviteMember,
  removeMember,
  setSkipperRole,
  updateMember,
  type MemberState,
} from "@/lib/actions/trip-members";
import type { TripMemberRow } from "@/lib/queries/trips";
import { formatDate } from "@/lib/utils";

const initial: MemberState = { status: "idle" };

export function CrewSection({
  tripId,
  members,
  canEdit,
  ownerId,
  startDate,
  endDate,
}: {
  tripId: string;
  members: TripMemberRow[];
  canEdit: boolean;
  ownerId: string;
  startDate: string;
  endDate: string;
}) {
  const [showForm, setShowForm] = useState(members.length === 0);
  const [state, formAction, pending] = useActionState(inviteMember, initial);
  const [, startTransition] = useTransition();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // Form nach erfolgreichem Submit automatisch zuklappen — aber nur einmal
  // pro Submit. Vorherige Implementation startete bei jedem Render einen
  // neuen setTimeout, sodass das Form direkt wieder zuging, wenn der User
  // es nach „ok" erneut über „Hinzufügen" öffnete.
  // Lösung: useEffect mit `state`-Dependency (neue Objekt-Referenz bei
  // jedem Submit) — re-öffnen via Button löst den Effect nicht aus.
  useEffect(() => {
    if (state.status !== "ok") return;
    const t = setTimeout(() => setShowForm(false), 800);
    return () => clearTimeout(t);
  }, [state]);

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-primary">Crew</h2>
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
          Keine Crew angelegt.
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
                      title={m.person_id === ownerId ? "Original-Skipper" : "Co-Skipper"}
                    >
                      <Anchor className="h-3 w-3" />
                      {m.person_id === ownerId ? "Skipper" : "Co-Skipper"}
                    </span>
                  )}
                  {m.is_alcoholic_effective && (
                    <span className="rounded-full bg-gold-soft px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gold">
                      🍷
                    </span>
                  )}
                </p>
                {m.email && <p className="text-xs text-ink-soft">{m.email}</p>}
                <p className="mt-1 text-xs text-ink-soft">
                  An Bord:{" "}
                  {m.on_board_from ? formatDate(m.on_board_from) : "ab Törn-Start"}
                  {" – "}
                  {m.on_board_to ? formatDate(m.on_board_to) : "bis Ende"}
                </p>
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
                        ? `Skipper-Rechte für ${m.display_name} entziehen`
                        : `${m.display_name} zum Skipper machen`
                    }
                    title={
                      m.person_id === ownerId
                        ? "Der Original-Skipper kann nicht degradiert werden."
                        : m.is_skipper
                          ? "Skipper-Rechte entziehen"
                          : "Zum Co-Skipper machen"
                    }
                  >
                    <Anchor className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setEditingId(editingId === m.id ? null : m.id)
                    }
                    className="rounded-md p-1.5 text-ink-soft hover:bg-paper-soft hover:text-primary"
                    aria-label={`${m.display_name} bearbeiten`}
                    title="Bearbeiten"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      startTransition(async () => {
                        if (
                          m.person_id !== ownerId &&
                          confirm(`${m.display_name} aus der Crew entfernen?`)
                        ) {
                          setRemoveError(null);
                          const res = await removeMember(m.id, tripId);
                          if (!res.ok) {
                            setRemoveError(`${m.display_name}: ${res.message}`);
                          }
                        }
                      })
                    }
                    disabled={m.person_id === ownerId}
                    className="rounded-md p-1.5 text-ink-soft hover:bg-paper-soft hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label={`${m.display_name} entfernen`}
                    title={
                      m.person_id === ownerId
                        ? "Der Original-Skipper kann nicht entfernt werden."
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
                onClose={() => setEditingId(null)}
              />
            )}
          </li>
        ))}
      </ul>

      {showForm && canEdit && (
        <form
          action={formAction}
          className="mt-4 space-y-3 rounded-md border border-rule bg-paper-soft p-4"
        >
          <div className="flex items-center justify-between">
            <h3 className="font-medium">Crew-Mitglied hinzufügen</h3>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="text-ink-soft hover:text-ink"
              aria-label="Abbrechen"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <input type="hidden" name="trip_id" value={tripId} />

          <div>
            <label htmlFor="email" className="block text-sm font-medium">E-Mail</label>
            <input id="email" name="email" type="email" required
              placeholder="crew@example.com"
              className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>

          <div>
            <label htmlFor="display_name" className="block text-sm font-medium">
              Anzeigename <span className="text-ink-soft font-normal">(optional)</span>
            </label>
            <input id="display_name" name="display_name" type="text"
              placeholder="Wird aus E-Mail abgeleitet wenn leer"
              className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="on_board_from" className="block text-xs font-medium">
                An Bord ab
              </label>
              <input id="on_board_from" name="on_board_from" type="date"
                min={startDate} max={endDate}
                placeholder={startDate}
                className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div>
              <label htmlFor="on_board_to" className="block text-xs font-medium">
                An Bord bis
              </label>
              <input id="on_board_to" name="on_board_to" type="date"
                min={startDate} max={endDate}
                placeholder={endDate}
                className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </div>
          </div>

          <div>
            <label htmlFor="is_alcoholic" className="block text-sm font-medium">
              Alkohol-Trinker?
            </label>
            <select id="is_alcoholic" name="is_alcoholic"
              defaultValue=""
              className="mt-1 w-full rounded-md border border-rule bg-paper px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            >
              <option value="">Default aus Person übernehmen</option>
              <option value="yes">Ja — bekommt Alkohol-Anteil</option>
              <option value="no">Nein — kein Alkohol-Anteil</option>
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
            <p className="text-sm text-success" role="status">✓ Hinzugefügt.</p>
          )}

          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-md bg-primary px-4 py-2 font-medium text-paper hover:bg-navy-dark disabled:opacity-60"
          >
            {pending ? "Speichere …" : "Hinzufügen"}
          </button>
        </form>
      )}
    </section>
  );
}

/**
 * Inline-Edit-Form, die unter einem ausgewählten Crew-Eintrag erscheint.
 * Email + Name sind nur editierbar, wenn die Person noch keinen Auth-User hat
 * (Ghost) — sonst würden wir das globale Profil eines aktiven Users überschreiben.
 */
function EditMemberForm({
  member,
  tripId,
  startDate,
  endDate,
  onClose,
}: {
  member: TripMemberRow;
  tripId: string;
  startDate: string;
  endDate: string;
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
              (gesperrt — Person verwaltet ihren Namen selbst)
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
              (gesperrt — User ist eingeloggt)
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
            An Bord ab
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
            An Bord bis
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
          Alkohol-Trinker?
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
          <option value="yes">Ja — bekommt Alkohol-Anteil</option>
          <option value="no">Nein — kein Alkohol-Anteil</option>
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
