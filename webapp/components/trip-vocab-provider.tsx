"use client";

import { createContext, useContext } from "react";
import { tripVocab, type TripType, type TripVocab } from "@/lib/trip-vocab";

/**
 * Stellt das reise-typ-abhängige Vokabular allen Client-Komponenten INNERHALB
 * eines Törns zur Verfügung — ohne `tripType` durch jede Komponente fädeln zu
 * müssen. Gemountet im Trip-Layout (app/trips/[id]/layout.tsx).
 *
 * Server-Komponenten nutzen weiterhin `tripVocab(trip.trip_type)` direkt
 * (Context greift nur clientseitig). Außerhalb des Providers (kein Trip-
 * Kontext) liefert `useTripVocab()` das Segel-Vokabular als sicheren Default.
 */
const TripVocabContext = createContext<TripVocab>(tripVocab("sailing"));

export function TripVocabProvider({
  tripType,
  children,
}: {
  tripType: TripType | string | null | undefined;
  children: React.ReactNode;
}) {
  return (
    <TripVocabContext.Provider value={tripVocab(tripType)}>
      {children}
    </TripVocabContext.Provider>
  );
}

export function useTripVocab(): TripVocab {
  return useContext(TripVocabContext);
}
