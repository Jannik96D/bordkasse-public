"use client";

import { useActionState } from "react";
import { updateProfile, type ProfileState } from "./actions";

const initial: ProfileState = { status: "idle" };

export function ProfileForm({
  initialDisplayName,
  initialIsAlcoholic,
  email,
}: {
  initialDisplayName: string;
  initialIsAlcoholic: boolean;
  email: string;
}) {
  const [state, formAction, pending] = useActionState(updateProfile, initial);

  return (
    <form action={formAction} className="space-y-5">
      <div>
        <label htmlFor="email-display" className="block text-sm font-medium">
          E-Mail
        </label>
        <input
          id="email-display"
          type="email"
          value={email}
          disabled
          className="mt-1 w-full rounded-md border border-rule bg-paper-soft px-4 text-base text-ink-soft"
        />
        <p className="mt-1 text-xs text-ink-soft">
          Wird beim nächsten Login als Identität verwendet — nicht änderbar.
        </p>
      </div>

      <div>
        <label htmlFor="display_name" className="block text-sm font-medium">
          Anzeigename
        </label>
        <input
          id="display_name"
          name="display_name"
          type="text"
          required
          defaultValue={initialDisplayName}
          className="mt-1 w-full rounded-md border border-rule bg-paper px-4 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
      </div>

      <div className="rounded-md bg-paper-soft p-4">
        <label htmlFor="is_alcoholic" className="flex items-start gap-3 cursor-pointer">
          <input
            id="is_alcoholic"
            name="is_alcoholic"
            type="checkbox"
            defaultChecked={initialIsAlcoholic}
            className="mt-1 h-5 w-5 rounded border-rule"
          />
          <span>
            <span className="block font-medium">Ich trinke Alkohol</span>
            <span className="mt-1 block text-xs text-ink-soft">
              Default für neue Törns. Pro Törn kannst du das übersteuern.
              Beeinflusst, wer den Alkohol-Anteil bei Ausgaben mitträgt.
            </span>
          </span>
        </label>
      </div>

      {state.status === "error" && (
        <p className="text-sm text-danger" role="alert">
          {state.message}
        </p>
      )}
      {state.status === "ok" && (
        <p className="text-sm text-success" role="status">
          ✓ Gespeichert.
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-primary px-4 font-medium text-paper transition-colors hover:bg-navy-dark disabled:opacity-60"
      >
        {pending ? "Speichere …" : "Speichern"}
      </button>
    </form>
  );
}
