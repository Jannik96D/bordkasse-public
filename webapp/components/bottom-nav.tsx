"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Plus, Euro, ScaleIcon, Wallet, BarChart3, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

interface Tab {
  href: (id: string) => string;
  match: (path: string, id: string) => boolean;
  label: string;
  Icon: typeof LayoutDashboard;
}

const tabs: Tab[] = [
  {
    href: (id) => `/trips/${id}`,
    match: (p, id) => p === `/trips/${id}`,
    label: "Übersicht",
    Icon: LayoutDashboard,
  },
  {
    href: (id) => `/trips/${id}/transactions`,
    match: (p, id) => p.startsWith(`/trips/${id}/transactions`),
    label: "Buchungen",
    Icon: Euro,
  },
  {
    href: (id) => `/trips/${id}/stats`,
    match: (p, id) => p.startsWith(`/trips/${id}/stats`),
    label: "Statistik",
    Icon: BarChart3,
  },
  {
    href: (id) => `/trips/${id}/balance`,
    match: (p, id) => p.startsWith(`/trips/${id}/balance`),
    label: "Bilanz",
    Icon: ScaleIcon,
  },
  {
    href: (id) => `/trips/${id}/debts`,
    match: (p, id) => p.startsWith(`/trips/${id}/debts`),
    label: "Schulden",
    Icon: Wallet,
  },
];

export function BottomNav({ tripId }: { tripId: string }) {
  const path = usePathname();

  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-rule bg-paper/95 backdrop-blur-sm pb-[env(safe-area-inset-bottom)]">
      <ul className="mx-auto grid max-w-2xl grid-cols-5">
        {tabs.map((t) => {
          const active = t.match(path, tripId);
          return (
            <li key={t.label}>
              <Link
                href={t.href(tripId)}
                className={cn(
                  "flex flex-col items-center gap-1 py-2 text-[11px] transition-colors",
                  active ? "text-primary" : "text-ink-soft hover:text-ink",
                )}
              >
                <t.Icon className={cn("h-5 w-5", active && "stroke-[2.5]")} />
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Floating-Action-Button für "+ Buchung" — primär CTA. */
export function FabAddTransaction({ tripId }: { tripId: string }) {
  return (
    <Link
      href={`/trips/${tripId}/transactions/new`}
      aria-label="Neue Buchung"
      className="fixed bottom-20 right-6 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-paper shadow-lg transition-transform hover:bg-navy-dark active:scale-95"
    >
      <Plus className="h-7 w-7" />
    </Link>
  );
}
export { Settings };
