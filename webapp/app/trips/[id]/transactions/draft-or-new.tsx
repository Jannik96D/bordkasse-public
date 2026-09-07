"use client";

import { useEffect, useState, type ReactNode } from "react";
import { DraftEditor } from "./draft-editor";
import { readDraftIdFromHash } from "@/lib/offline/draft-hash";
import type { TrancheOption } from "./new/transaction-form";
import type { CurrencyChoice } from "./new/transaction-form-parts";

type Member = {
  person_id: string;
  display_name: string;
  on_board_from?: string | null;
  on_board_to?: string | null;
  is_alcoholic_effective?: boolean;
};
type Category = { id: string; name: string; icon: string | null };

export function DraftOrNewForm({
  formElement,
  tripId,
  isSkipper,
  members,
  categories,
  currentPersonId,
  tranches,
  canEditTranche,
  currencyOptions,
  tripStart,
  tripEnd,
}: {
  /** Vorgerenderte `<TransactionForm .../>` für den Nicht-Draft-Fall. */
  formElement: ReactNode;
  tripId: string;
  isSkipper: boolean;
  members: Member[];
  categories: Category[];
  currentPersonId?: string;
  tranches?: TrancheOption[];
  canEditTranche: boolean;
  currencyOptions?: CurrencyChoice[];
  tripStart?: string;
  tripEnd?: string;
}) {
  // Start optimistisch bei "kein Draft" (= identisch zum SSR-Ergebnis, das
  // das Hash-Fragment nie sieht — sonst Hydration-Mismatch). Das ist der
  // weit überwiegende Fall (normale Buchungsanlage ohne Draft): kein Flash
  // von leer → Formular mehr bei JEDEM Seitenaufruf (Grill-Review-Fund,
  // PR 5) — nur im seltenen Draft-Fall zeigt sich kurz das leere Formular,
  // bevor der Effect den Draft-Editor einblendet.
  const [draftId, setDraftId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const fromHash = readDraftIdFromHash(window.location.hash);
    if (fromHash) {
      // setTimeout 0 verschiebt das Setzen aus dem synchronen Effect-Body —
      // erfüllt react-hooks/set-state-in-effect (gleiches Muster wie
      // components/toast.tsx), ohne dass der Nutzer eine Verzögerung sieht.
      const handle = setTimeout(() => setDraftId(fromHash), 0);
      return () => clearTimeout(handle);
    }
  }, []);

  if (draftId) {
    return (
      <DraftEditor
        draftId={draftId}
        tripId={tripId}
        isSkipper={isSkipper}
        members={members}
        categories={categories}
        currentPersonId={currentPersonId}
        tranches={tranches}
        canEditTranche={canEditTranche}
        currencyOptions={currencyOptions}
        tripStart={tripStart}
        tripEnd={tripEnd}
      />
    );
  }

  return <>{formElement}</>;
}
