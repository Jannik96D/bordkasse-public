"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * Subscribed auf alle DB-Änderungen, die die Bilanz beeinflussen können
 * (transactions, transaction_participants, trip_members des aktuellen
 * Trips). Bei jedem Event: router.refresh() — Server Components rendern
 * neu mit aktualisierten Daten aus den Views.
 *
 * Spec: docs/web-app-spec.md §Realtime-Synchronisation
 */
export function RealtimeTrip({ tripId }: { tripId: string }) {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`trip-${tripId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "transactions", filter: `trip_id=eq.${tripId}` },
        () => router.refresh(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "trip_members", filter: `trip_id=eq.${tripId}` },
        () => router.refresh(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "settled_debts", filter: `trip_id=eq.${tripId}` },
        () => router.refresh(),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [tripId, router]);

  return null;
}
