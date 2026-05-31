"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Plus, Euro, ScaleIcon, Wallet, BarChart3, Coins, Settings } from "lucide-react";
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

// Kontextueller Anzahlungs-Tab — wird nur eingeblendet, solange Anzahlungen
// für den Betrachter relevant sind (siehe getPrepaymentNavState). Position:
// direkt nach "Übersicht" (zweiter Tab von links), weil die Anzahlung
// chronologisch VOR dem Törn der erste Schritt ist. Eigenes Icon, weil
// "Schulden" bereits das Wallet-Icon belegt.
const prepaymentTab: Tab = {
  href: (id) => `/trips/${id}/prepayments`,
  match: (p, id) => p.startsWith(`/trips/${id}/prepayments`),
  label: "Anzahlung",
  Icon: Coins,
};

export function BottomNav({
  tripId,
  showPrepayments = false,
}: {
  tripId: string;
  showPrepayments?: boolean;
}) {
  const path = usePathname();

  const visibleTabs = showPrepayments
    ? [tabs[0], prepaymentTab, ...tabs.slice(1)]
    : tabs;

  return (
    <nav
      aria-label="Hauptnavigation"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-rule bg-paper/95 backdrop-blur-sm pb-[env(safe-area-inset-bottom)]"
    >
      <ul className={cn("mx-auto grid max-w-2xl", showPrepayments ? "grid-cols-6" : "grid-cols-5")}>
        {visibleTabs.map((t) => {
          const active = t.match(path, tripId);
          return (
            <li key={t.label}>
              <Link
                href={t.href(tripId)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  // min-h-touch sichert das 44px-Tap-Ziel auch auf reinen <a>
                  // (die globale CSS-Regel greift nur auf a.button) — bei
                  // py-2 + Icon + Label ohnehin schon erfüllt, hier als Garantie.
                  "flex min-h-touch flex-col items-center justify-center gap-1 py-2 text-[11px] transition-colors",
                  active ? "text-primary" : "text-ink-soft hover:text-ink",
                )}
              >
                <t.Icon className={cn("h-5 w-5", active && "stroke-[2.5]")} aria-hidden />
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
  const href = `/trips/${tripId}/transactions/new`;
  return (
    <Link
      href={href}
      onClick={(e) => {
        // Offline: Hard-Navigation erzwingen. Client-RSC-Navigation scheitert
        // offline (Service Worker cacht keine RSC-Payloads); ein echter
        // Navigate-Request liefert dagegen das vorgewärmte Form-Dokument aus.
        if (typeof navigator !== "undefined" && !navigator.onLine) {
          e.preventDefault();
          window.location.assign(href);
        }
      }}
      aria-label="Neue Buchung"
      className="fixed bottom-20 right-6 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-paper shadow-lg transition-transform hover:bg-navy-dark active:scale-95"
    >
      <Plus className="h-7 w-7" />
    </Link>
  );
}
export { Settings };
