"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/toast-provider";

/**
 * Subscribed auf alle DB-Änderungen, die die Bilanz beeinflussen können
 * (transactions, transaction_participants, trip_members des aktuellen
 * Trips). Bei jedem Event: gebündeltes router.refresh() — Server Components
 * rendern neu mit aktualisierten Daten aus den Views.
 *
 * Mehrere Events kurz hintereinander (z. B. eine Buchung schreibt parallel
 * in transactions + transaction_participants) werden über ein 500-ms-Debounce
 * zu EINEM Refresh zusammengefasst. Stammt die Änderung von jemand anderem,
 * zeigt ein dezenter Toast „Von einem Crew-Mitglied aktualisiert" — eigene
 * Änderungen lösen keinen Hinweis aus (vergleicht created_by /
 * settled_by_person_id gegen die eingeloggte Person).
 *
 * Spec: docs/web-app-spec.md §Realtime-Synchronisation
 */
export function RealtimeTrip({
  tripId,
  currentPersonId,
}: {
  tripId: string;
  currentPersonId?: string;
}) {
  const router = useRouter();
  const { show } = useToast();

  useEffect(() => {
    const supabase = createClient();
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    // Wurde seit dem letzten Refresh eine Fremd-Änderung gesehen? Steuert,
    // ob nach dem gebündelten Refresh ein Toast erscheint.
    let sawForeignChange = false;

    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        router.refresh();
        if (sawForeignChange) {
          show("Von einem Crew-Mitglied aktualisiert.", { variant: "info" });
        }
        sawForeignChange = false;
      }, 500);
    };

    // Ist die Änderung von jemand anderem? actorField trägt je nach Tabelle
    // die ID der handelnden Person. Bei DELETE ist payload.new leer → als
    // fremd werten (wir können den Akteur nicht zuordnen).
    const onChange = (actorField?: string) => (payload: { new?: Record<string, unknown> }) => {
      const actor = actorField ? (payload.new?.[actorField] as string | undefined) : undefined;
      if (!currentPersonId || !actor || actor !== currentPersonId) {
        sawForeignChange = true;
      }
      scheduleRefresh();
    };

    const channel = supabase
      .channel(`trip-${tripId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "transactions", filter: `trip_id=eq.${tripId}` },
        onChange("created_by"),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "trip_members", filter: `trip_id=eq.${tripId}` },
        onChange(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "settled_debts", filter: `trip_id=eq.${tripId}` },
        onChange("settled_by_person_id"),
      )
      .subscribe();

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      supabase.removeChannel(channel);
    };
  }, [tripId, currentPersonId, router, show]);

  return null;
}
