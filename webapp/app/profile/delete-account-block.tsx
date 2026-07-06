"use client";

import { useActionState, useState } from "react";
import { Trash2, AlertTriangle } from "lucide-react";
import { deleteMyAccount, type DeleteAccountState } from "./actions";

const initial: DeleteAccountState = { status: "idle" };

/**
 * Self-Service-Kontolöschung im Profil. Ausgeklappter `<details>`-Block
 * mit Warntext + Bestätigungs-Checkbox + Lösch-Button. Die Bestätigung
 * verhindert versehentliche Klicks; die Server-Action prüft zusätzlich
 * serverseitig, ob noch Buchungen in aktiven Trips offen sind.
 *
 * Nach erfolgreicher Löschung redirected die Action auf
 * `/?account_deleted=1` — der User landet auf der Startseite, ist
 * abgemeldet und kann sich mit derselben Mail nicht mehr einloggen
 * (Whitelist greift nicht mehr, persons_private ist leer).
 */
export function DeleteAccountBlock() {
  const [state, formAction, pending] = useActionState(deleteMyAccount, initial);
  const [confirmed, setConfirmed] = useState(false);

  return (
    <details className="mt-12 group rounded-md border border-rule bg-paper-soft p-4">
      <summary className="cursor-pointer text-sm font-medium text-ink-soft group-open:text-danger">
        <Trash2 className="inline h-4 w-4 mr-1" />
        Konto löschen
      </summary>
      <div className="mt-4 space-y-3 text-sm">
        <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
          <div className="text-xs text-ink">
            <p className="font-medium text-danger">Endgültig — keine Wiederherstellung.</p>
            <p className="mt-1 text-ink-soft">
              Beim Löschen werden deine E-Mail-Adresse, dein Nachname und dein Login
              entfernt. In Törns mit Buchungen, an denen du beteiligt warst, bleibt
              dein <em>Vorname</em> bestehen, damit die Bilanz nicht zerbricht.
              Er wird durch „Ehemaliges Crewmitglied“ ersetzt.
            </p>
            <p className="mt-2 text-ink-soft">
              <strong>Voraussetzung:</strong> Du hast in <em>aktiven</em> Törns
              (noch nicht zu Ende) keine Buchungen erfasst. Sonst zuerst Törnende
              abwarten oder deinen Skipper bitten, deine Buchungen umzubuchen.
            </p>
          </div>
        </div>

        <label className="flex items-start gap-2 text-xs text-ink-soft">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-rule text-danger focus:ring-danger"
          />
          <span>
            Ich bin sicher, dass ich mein Konto löschen will. Mir ist klar,
            dass das nicht rückgängig gemacht werden kann.
          </span>
        </label>

        <form action={formAction}>
          <button
            type="submit"
            disabled={!confirmed || pending}
            className="inline-flex items-center gap-1.5 rounded-md bg-danger px-3 py-1.5 text-xs font-medium text-paper disabled:cursor-not-allowed disabled:opacity-40 hover:bg-danger/90"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            {pending ? "Lösche …" : "Konto endgültig löschen"}
          </button>
        </form>

        {state.status === "error" && (
          <p className="text-xs text-danger" role="alert">{state.message}</p>
        )}
      </div>
    </details>
  );
}
