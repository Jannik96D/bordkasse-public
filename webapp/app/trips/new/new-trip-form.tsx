"use client";

import { useActionState } from "react";
import Link from "next/link";
import { createTrip, type TripState } from "@/lib/actions/trips";
import { todayIso } from "@/lib/utils";

const initial: TripState = { status: "idle" };

export function NewTripForm() {
  const [state, formAction, pending] = useActionState(createTrip, initial);
  const today = todayIso();

  return (
    <main className="mx-auto w-full max-w-md px-6 py-10">
      <div className="mb-6">
        <Link href="/" className="text-sm text-ink-soft hover:text-primary">
          ← Übersicht
        </Link>
      </div>

      <h1 className="text-2xl font-bold text-primary">Neuer Törn</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Stammdaten reichen — Crew und Kategorien fügst du im nächsten Schritt hinzu.
      </p>

      <form action={formAction} className="mt-8 space-y-5">
        <div>
          <label htmlFor="name" className="block text-sm font-medium">
            Törn-Name
          </label>
          <input
            id="name"
            name="name"
            type="text"
            required
            placeholder="IJsselmeer Mai 2026"
            className="mt-1 w-full rounded-md border border-rule bg-paper px-4 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="start_date" className="block text-sm font-medium">
              Start
            </label>
            <input
              id="start_date"
              name="start_date"
              type="date"
              required
              defaultValue={today}
              className="mt-1 w-full rounded-md border border-rule bg-paper px-4 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div>
            <label htmlFor="end_date" className="block text-sm font-medium">
              Ende
            </label>
            <input
              id="end_date"
              name="end_date"
              type="date"
              required
              defaultValue={today}
              className="mt-1 w-full rounded-md border border-rule bg-paper px-4 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>
        </div>

        <div>
          <label htmlFor="ship_name" className="block text-sm font-medium">
            Schiffsname <span className="text-ink-soft font-normal">(optional)</span>
          </label>
          <input
            id="ship_name"
            name="ship_name"
            type="text"
            placeholder="z. B. Bavaria 36"
            className="mt-1 w-full rounded-md border border-rule bg-paper px-4 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </div>

        {state.status === "error" && (
          <p className="text-sm text-danger" role="alert">{state.message}</p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md bg-primary px-4 font-medium text-paper transition-colors hover:bg-navy-dark disabled:opacity-60"
        >
          {pending ? "Lege an …" : "Törn anlegen → Crew hinzufügen"}
        </button>
      </form>
    </main>
  );
}
