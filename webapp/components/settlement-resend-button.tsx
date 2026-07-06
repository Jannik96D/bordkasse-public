"use client";

import { RefreshCw } from "lucide-react";
import { resendSettlement } from "@/lib/actions/settlement";
import { useTripVocab } from "@/components/trip-vocab-provider";
import { SettlementMailButton } from "@/components/settlement-mail-button";

/**
 * Skipper-Button "Update-Mail verschicken" — wird angezeigt, wenn nach der
 * initialen Abrechnung Buchungen geändert wurden (changes_pending_since
 * gesetzt). Schickt eine Mail mit dem Wortlaut "Bilanz aktualisiert" und
 * dem aktuellen Saldo + Zahlungsplan an jedes Crewmitglied. Gemeinsame
 * Mechanik in SettlementMailButton.
 */
export function SettlementResendButton({ tripId }: { tripId: string }) {
  const vocab = useTripVocab();
  return (
    <SettlementMailButton
      tripId={tripId}
      action={resendSettlement}
      confirmTitle="Update-Mail verschicken?"
      confirmBody={`Alle in der ${vocab.crew} mit E-Mail-Adresse bekommen eine Mail mit der aktualisierten Bilanz und dem neuen Zahlungsplan.`}
      idleLabel="Update-Mail verschicken"
      okPrefix="Update verschickt"
      renderIcon={(pending) => <RefreshCw className={`h-3.5 w-3.5 ${pending ? "animate-spin" : ""}`} aria-hidden />}
    />
  );
}
