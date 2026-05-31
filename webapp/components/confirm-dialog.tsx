"use client";

import { useCallback, useId, useRef, useState } from "react";
import { Modal } from "@/components/modal";
import { cn } from "@/lib/utils";

/**
 * Bestätigungs-Dialog statt nativem `window.confirm()` — markenkonform,
 * barrierefrei (role="alertdialog", Fokus-Trap via Modal) und mit klarem
 * Konsequenz-Text. Initialer Fokus liegt bewusst auf „Abbrechen" (erstes
 * fokussierbares Element), nicht auf dem destruktiven Button.
 *
 * Benutzung über den `useConfirm()`-Hook (promise-basiert):
 *
 *   const { confirm, confirmDialog } = useConfirm();
 *   // im Handler:
 *   if (!(await confirm({ title: "…", body: "…", danger: true }))) return;
 *   // im JSX:
 *   {confirmDialog}
 */

export type ConfirmOptions = {
  title: string;
  /** Konsequenz-Text — was passiert beim Bestätigen. */
  body: string;
  /** Beschriftung des Bestätigen-Buttons. Default „Bestätigen". */
  confirmLabel?: string;
  /** Beschriftung des Abbrechen-Buttons. Default „Abbrechen". */
  cancelLabel?: string;
  /** Rot eingefärbter Bestätigen-Button für destruktive Aktionen. */
  danger?: boolean;
};

type PendingConfirm = ConfirmOptions & { resolve: (ok: boolean) => void };

export function useConfirm() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  // Ref auf den aktuellen resolve, damit Schließen ohne Entscheidung als
  // „abgebrochen" (false) auflöst und keine hängende Promise zurücklässt.
  const resolveRef = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setPending({ ...opts, resolve });
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    resolveRef.current?.(ok);
    resolveRef.current = null;
    setPending(null);
  }, []);

  const confirmDialog = pending ? (
    <ConfirmDialog
      options={pending}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  ) : null;

  return { confirm, confirmDialog };
}

function ConfirmDialog({
  options,
  onConfirm,
  onCancel,
}: {
  options: ConfirmOptions;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const { title, body, confirmLabel = "Bestätigen", cancelLabel = "Abbrechen", danger } = options;

  return (
    <Modal
      role="alertdialog"
      labelledBy={titleId}
      describedBy={bodyId}
      onClose={onCancel}
      className="flex w-full max-w-sm flex-col gap-4 rounded-lg border border-rule bg-paper p-5 shadow-xl outline-none"
    >
      <div>
        <h2 id={titleId} className="text-lg font-bold text-primary">
          {title}
        </h2>
        <p id={bodyId} className="mt-2 text-sm text-ink-soft">
          {body}
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        {/* Abbrechen zuerst im DOM → erhält den initialen Fokus (Modal fokussiert
            das erste fokussierbare Element). Auf Desktop steht der Bestätigen-
            Button rechts (sm:justify-end), auf Mobile gestapelt darunter. */}
        <button
          type="button"
          onClick={onCancel}
          className="min-h-touch rounded-md border border-rule bg-paper px-4 py-2 text-sm font-medium text-ink hover:bg-paper-soft"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className={cn(
            "min-h-touch rounded-md px-4 py-2 text-sm font-medium text-paper",
            danger ? "bg-danger hover:bg-danger/90" : "bg-primary hover:bg-navy-dark",
          )}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
