"use client";

import { Send } from "lucide-react";
import { announceSettlement } from "@/lib/actions/settlement";
import { useTripVocab } from "@/components/trip-vocab-provider";
import { SettlementMailButton } from "@/components/settlement-mail-button";

/**
 * Skipper-Button "Abrechnung verschicken" — löst Mailversand an die Crew aus
 * und schaltet die Bezahlt-Häkchen frei. Mit `confirm()`, damit der Click
 * nicht versehentlich passiert (Idempotent ist die Action zwar, aber die
 * Mails wären weg). Gemeinsame Mechanik in SettlementMailButton.
 */
export function SettlementAnnounceButton({ tripId }: { tripId: string }) {
  const vocab = useTripVocab();
  return (
    <SettlementMailButton
      tripId={tripId}
      action={announceSettlement}
      confirmTitle="Abrechnung verschicken?"
      confirmBody={`Es geht eine Mail an jedes ${vocab.member} mit E-Mail-Adresse — mit Saldo und Zahlungsplan. Danach sind die Bezahlt-Häkchen freigeschaltet.`}
      idleLabel="Abrechnung verschicken"
      okPrefix="Abrechnung verschickt"
      renderIcon={() => <Send className="h-3.5 w-3.5" aria-hidden />}
    />
  );
}
