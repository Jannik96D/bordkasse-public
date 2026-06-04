"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { createTrip, type TripState } from "@/lib/actions/trips";
import { todayIso } from "@/lib/utils";
import { tripVocab, type TripType } from "@/lib/trip-vocab";

const initial: TripState = { status: "idle" };

export function NewTripForm() {
  const [state, formAction, pending] = useActionState(createTrip, initial);
  const today = todayIso();
  // Kein Tripkontext auf /trips/new → das Vokabular wird vom gewählten
  // Radio-Wert getrieben (statt useTripVocab). So spiegeln Schiffsname-/
  // Skipper-Labels sofort die getroffene Reise-Art wider.
  const [selectedType, setSelectedType] = useState<TripType>("sailing");
  const vocab = tripVocab(selectedType);

  return (
    <main className="mx-auto w-full max-w-md px-6 py-10">
      <div className="mb-6">
        <Link href="/" className="text-sm text-ink-soft hover:text-primary">
          ← Übersicht
        </Link>
      </div>

      <h1 className="text-2xl font-bold text-primary">
        {selectedType === "other" ? "Neue Reise" : "Neuer Törn"}
      </h1>
      <p className="mt-1 text-sm text-ink-soft">
        Stammdaten reichen, {vocab.crew} und Kategorien fügst du im nächsten Schritt hinzu.
      </p>

      <form action={formAction} className="mt-8 space-y-5">
        <div>
          <label htmlFor="name" className="block text-sm font-medium">
            {vocab.trip}name
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
            {vocab.shipName} <span className="text-ink-soft font-normal">(optional)</span>
          </label>
          <input
            id="ship_name"
            name="ship_name"
            type="text"
            placeholder={vocab.shipNamePlaceholder}
            className="mt-1 w-full rounded-md border border-rule bg-paper px-4 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </div>

        <fieldset className="rounded-md border border-rule bg-paper-soft p-3">
          <legend className="px-1 text-sm font-medium">Reise-Art</legend>
          <div className="mt-1 space-y-2">
            <label className="flex items-start gap-2.5">
              <input
                type="radio"
                name="trip_type"
                value="sailing"
                checked={selectedType === "sailing"}
                onChange={() => setSelectedType("sailing")}
                className="mt-1 h-4 w-4"
              />
              <span className="text-sm">
                <span className="font-medium">Segeltörn</span>
                <span className="block text-xs text-ink-soft">
                  Standard. Zählt in die Gesamtstatistik.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2.5">
              <input
                type="radio"
                name="trip_type"
                value="other"
                checked={selectedType === "other"}
                onChange={() => setSelectedType("other")}
                className="mt-1 h-4 w-4"
              />
              <span className="text-sm">
                <span className="font-medium">Andere Reise</span>
                <span className="block text-xs text-ink-soft">
                  z. B. Gruppen-Urlaub. Neutrale Begriffe (Reisegruppe,
                  Urlaubsanzahlung) und nicht in der Gesamtstatistik.
                </span>
              </span>
            </label>
          </div>
        </fieldset>

        <div className="rounded-md border border-rule bg-paper-soft p-3">
          <label htmlFor="skipper_email" className="block text-sm font-medium">
            {vocab.skipper} <span className="text-ink-soft font-normal">(optional)</span>
          </label>
          <input
            id="skipper_email"
            name="skipper_email"
            type="email"
            placeholder="leer = du selbst"
            className="mt-1 w-full rounded-md border border-rule bg-paper px-4 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
          <p className="mt-2 text-xs text-ink-soft">
            E-Mail {vocab.skipper === "Skipper" ? "des zukünftigen Skippers" : "der zukünftigen Reiseleitung"}. Lass das Feld leer, wenn du
            selbst {vocab.skipper === "Skipper" ? "Skipper" : "die Reiseleitung"} sein möchtest. Wenn du {vocab.trip === "Reise" ? "die Reise" : "den Törn"} für jemand
            anderen anlegst, {vocab.skipper === "Skipper" ? "wird er Skipper" : "übernimmt diese Person die Reiseleitung"}, du selbst landest nicht
            in der {vocab.crew}, hast aber als Admin trotzdem vollen Zugriff.
          </p>
        </div>

        {state.status === "error" && (
          <p className="text-sm text-danger" role="alert">{state.message}</p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md bg-primary px-4 font-medium text-paper transition-colors hover:bg-navy-dark disabled:opacity-60"
        >
          {pending ? "Lege an …" : `${vocab.trip} anlegen → ${vocab.crew} hinzufügen`}
        </button>
      </form>
    </main>
  );
}
