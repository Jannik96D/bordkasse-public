"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { CloudOff, Pencil, Trash2 } from "lucide-react";
import {
  listAll,
  remove,
  subscribeToChanges,
  type OutboxItem,
} from "@/lib/offline/outbox";
import { useConfirm } from "@/components/confirm-dialog";
import { useToast } from "@/components/toast-provider";
import { formatEuro } from "@/lib/utils";

function subscribeOnline(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

function str(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}
function num(v: string | string[] | undefined): number {
  const s = str(v);
  if (s === "") return 0;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

/** Anzeige-Daten aus der rohen Outbox-formData ableiten. */
function describe(item: OutboxItem, names: Record<string, string>) {
  const d = item.formData;
  if (item.kind === "expense") {
    const total = num(d.amount) + num(d.tip_amount);
    return {
      title: str(d.description) || "(ohne Beschreibung)",
      sub: names[str(d.paid_by)] ?? "?",
      amount: total,
      isCredit: false,
    };
  }
  const to = str(d.credit_to);
  return {
    title: str(d.description) || "Gutschrift",
    sub: `${names[str(d.credit_from)] ?? "?"} → ${to === "ALL" || to === "" ? "Alle" : names[to] ?? "?"}`,
    amount: num(d.amount),
    isCredit: true,
  };
}

/**
 * Zeigt offline erfasste, noch nicht gesyncte Buchungen oberhalb der echten
 * Liste — als „wartet"-Karten mit Bearbeiten/Löschen. So lässt sich ein
 * Tippfehler vor dem Sync noch korrigieren. Items verschwinden automatisch,
 * sobald der Sync sie aus der Outbox entfernt (subscribeToChanges).
 */
export function PendingTransactions({
  tripId,
  memberNames,
}: {
  tripId: string;
  /** person_id → display_name, zum Auflösen von Bezahler/Gutschrift-Parteien. */
  memberNames: Record<string, string>;
}) {
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
  const [items, setItems] = useState<OutboxItem[]>([]);
  const { confirm, confirmDialog } = useConfirm();
  const toast = useToast();

  const refresh = useCallback(async () => {
    try {
      const all = await listAll();
      setItems(all.filter((i) => i.tripId === tripId));
    } catch {
      setItems([]);
    }
  }, [tripId]);

  useEffect(() => {
    const unsubscribe = subscribeToChanges(refresh);
    // Initial-Load aus dem Effect heraus (kein State-Set im Render).
    const handle = setTimeout(refresh, 0);
    return () => {
      unsubscribe();
      clearTimeout(handle);
    };
  }, [refresh]);

  // Beim Online-Werden räumt der Sync die Outbox — kurz danach neu lesen,
  // damit erledigte Karten verschwinden, auch falls notifyChange mal verpufft.
  useEffect(() => {
    if (!online) return;
    const handle = setTimeout(refresh, 1500);
    return () => clearTimeout(handle);
  }, [online, refresh]);

  const handleDelete = async (item: OutboxItem) => {
    const ok = await confirm({
      title: "Entwurf verwerfen?",
      body: "Diese noch nicht übertragene Buchung wird gelöscht. Sie wurde noch nicht in die Bordkasse aufgenommen.",
      confirmLabel: "Verwerfen",
      danger: true,
    });
    if (!ok) return;
    try {
      await remove(item.id);
      toast.show("Entwurf verworfen.", { variant: "success" });
    } catch {
      toast.show("Konnte nicht gelöscht werden.", { variant: "error" });
    }
    refresh();
  };

  if (items.length === 0) return null;

  return (
    <section className="mb-6" aria-label="Noch nicht übertragene Buchungen">
      <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-soft">
        <CloudOff className="h-3.5 w-3.5" aria-hidden />
        {online ? "Wird übertragen" : "Wartet auf Übertragung"}
      </h2>
      <ul className="space-y-2">
        {items.map((item) => {
          const info = describe(item, memberNames);
          const editHref = `/trips/${tripId}/transactions/new?draft=${item.id}`;
          return (
            <li
              key={item.id}
              className="flex items-stretch overflow-hidden rounded-md border border-dashed border-warning/50 bg-warning/5"
            >
              <div className="flex min-w-0 flex-1 items-start justify-between gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {info.isCredit && (
                      <span className="mr-2 rounded-full bg-navy-light px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                        Gutschrift
                      </span>
                    )}
                    {info.title}
                  </p>
                  <p className="mt-1 text-xs text-ink-soft">
                    <span className="rounded-full bg-warning/20 px-2 py-0.5 font-medium text-ink">
                      {online ? "wird übertragen …" : "wartet"}
                    </span>
                    {" · "}
                    {info.sub}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className={`font-semibold ${info.isCredit ? "text-gold-dark" : "text-primary"}`}>
                    {formatEuro(info.amount)}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1 border-l border-warning/30 px-2">
                <Link
                  href={editHref}
                  onClick={(e) => {
                    // Offline: Hard-Navigation erzwingen, damit der Service Worker
                    // das gecachte Form-Dokument ausliefert (Client-RSC-Nav scheitert offline).
                    if (typeof navigator !== "undefined" && !navigator.onLine) {
                      e.preventDefault();
                      window.location.assign(editHref);
                    }
                  }}
                  className="rounded-md p-1.5 text-ink-soft hover:bg-paper-soft hover:text-primary"
                  aria-label={`Entwurf „${info.title}" bearbeiten`}
                  title="Bearbeiten"
                >
                  <Pencil className="h-4 w-4" />
                </Link>
                <button
                  type="button"
                  onClick={() => handleDelete(item)}
                  className="rounded-md p-1.5 text-ink-soft hover:bg-paper-soft hover:text-danger"
                  aria-label={`Entwurf „${info.title}" verwerfen`}
                  title="Verwerfen"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {confirmDialog}
    </section>
  );
}
