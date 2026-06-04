"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/toast-provider";
import { tripVocab, type TripType } from "@/lib/trip-vocab";

/**
 * Subscribed auf alle DB-Änderungen, die die Bilanz beeinflussen können
 * (transactions, transaction_participants, trip_members des aktuellen
 * Trips). Bei jedem Event: gebündeltes router.refresh() — Server Components
 * rendern neu mit aktualisierten Daten aus den Views.
 *
 * Mehrere Events kurz hintereinander (z. B. eine Buchung schreibt parallel
 * in transactions + transaction_participants) werden über ein 500-ms-Debounce
 * zu EINEM Refresh zusammengefasst.
 *
 * Toast-Logik (Problem-Fix):
 *   - Pro Tabelle eine KONKRETE Meldung („Eine Buchung wurde …", „Der
 *     Schulden-Status wurde …") statt eines nichtssagenden „aktualisiert".
 *   - Nur bei FREMD-Änderung (Akteur ≠ eingeloggte Person). Die Zuordnung
 *     läuft über das jeweilige Akteur-Feld (created_by / settled_by_person_id).
 *   - `trip_members` hat KEIN Akteur-Feld → eigen/fremd ist nicht
 *     unterscheidbar. Früher galt deshalb JEDE Crew-Änderung als „fremd" und
 *     löste auch beim eigenen Anlegen einen Toast aus (genau der gemeldete
 *     Fehlalarm). Lösung: für trip_members nur stilles Refresh, kein Toast.
 *
 * Spec: docs/web-app-spec.md §Realtime-Synchronisation
 */
export function RealtimeTrip({
  tripId,
  currentPersonId,
  tripType = "sailing",
}: {
  tripId: string;
  currentPersonId?: string;
  tripType?: TripType;
}) {
  const router = useRouter();
  const { show } = useToast();

  useEffect(() => {
    const supabase = createClient();
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    // Konkrete Meldung der zuletzt gesehenen Fremd-Änderung (null = keine
    // toast-würdige Änderung seit dem letzten Refresh).
    let pendingMessage: string | null = null;

    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        router.refresh();
        if (pendingMessage) show(pendingMessage, { variant: "info" });
        pendingMessage = null;
      }, 500);
    };

    const someone = `einem ${tripVocab(tripType).memberDative}`;

    // actorField = Spalte mit der ID der handelnden Person (für eigen/fremd).
    // message = null → nur stilles Refresh, kein Toast (z. B. trip_members,
    // wo der Akteur nicht ermittelbar ist).
    const onChange =
      (actorField: string | null, message: string | null) =>
      (payload: { new?: Record<string, unknown> }) => {
        if (message) {
          const actor = actorField
            ? (payload.new?.[actorField] as string | undefined)
            : undefined;
          const isForeign = !currentPersonId || !actor || actor !== currentPersonId;
          if (isForeign) pendingMessage = message;
        }
        scheduleRefresh();
      };

    const channel = supabase
      .channel(`trip-${tripId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "transactions", filter: `trip_id=eq.${tripId}` },
        onChange("created_by", `Eine Buchung wurde von ${someone} geändert.`),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "trip_members", filter: `trip_id=eq.${tripId}` },
        onChange(null, null),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "settled_debts", filter: `trip_id=eq.${tripId}` },
        onChange("settled_by_person_id", `Der Schulden-Status wurde von ${someone} aktualisiert.`),
      )
      .subscribe();

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      supabase.removeChannel(channel);
    };
  }, [tripId, currentPersonId, tripType, router, show]);

  return null;
}
