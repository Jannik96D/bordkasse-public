"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronLeft, Settings as SettingsIcon } from "lucide-react";
import { formatDate } from "@/lib/utils";

/**
 * Trip-Layout-Header — wird auf Top-Level-Pages eines Törns angezeigt
 * (Übersicht, Buchungen-Liste, Bilanz, Schulden, Statistik, Settings).
 *
 * Auf Sub-Pages (Buchungs-Detail, Edit-Form, Neue-Buchung-Form) rendert
 * der Header nichts, damit die Sub-Page ihren eigenen sticky Header mit
 * dem lokalen Zurück-Pfeil zeigen kann. So vermeidet man, dass der User
 * beim Scrollen nur den globalen "Zurück zur Trip-Liste"-Pfeil sieht.
 */
export function TripHeader({
  tripId,
  tripName,
  startDate,
  endDate,
  archived,
}: {
  tripId: string;
  tripName: string;
  startDate: string;
  endDate: string;
  archived: boolean;
}) {
  const pathname = usePathname() ?? "";

  // Sub-Page-Heuristik: Buchungs-Detail/Edit/Neu. Pattern:
  //   /trips/<id>/transactions/<txId>           → Detail
  //   /trips/<id>/transactions/<txId>/edit      → Edit
  //   /trips/<id>/transactions/new              → Neu
  const inSubPage = (() => {
    const prefix = `/trips/${tripId}/transactions/`;
    if (!pathname.startsWith(prefix)) return false;
    const rest = pathname.slice(prefix.length);
    if (rest === "" || rest === "/") return false; // /transactions/ ist die Liste
    return true; // alles tiefer als die Liste ist eine Sub-Page
  })();

  if (inSubPage) return null;

  // Datum-Zeile nur dort zeigen, wo sie inhaltlich Mehrwert hat — Übersicht
  // und Settings. Auf Buchungen / Bilanz / Schulden / Statistik / Anzahlungen
  // ist sie auf jedem Screen oben sichtbar, sagt aber nichts Aktuelles über
  // den Inhalt und kostet 16 px Höhe. Der archiviert-Hinweis bleibt überall.
  const isOverview = pathname === `/trips/${tripId}`;
  const isSettings = pathname === `/trips/${tripId}/settings`;
  const showDates = isOverview || isSettings;

  return (
    <header className="sticky top-0 z-10 border-b border-rule bg-paper/95 pt-[env(safe-area-inset-top)] backdrop-blur-sm">
      <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
        <Link
          href="/"
          className="flex h-10 w-10 items-center justify-center rounded-full text-ink-soft hover:bg-paper-soft hover:text-primary"
          aria-label="Zurück zur Übersicht"
        >
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold text-primary">{tripName}</h1>
          {showDates ? (
            <p className="truncate text-xs text-ink-soft">
              {formatDate(startDate)} – {formatDate(endDate)}
              {archived && " · archiviert"}
            </p>
          ) : archived ? (
            <p className="truncate text-xs text-ink-soft">archiviert</p>
          ) : null}
        </div>
        <Link
          href="/"
          aria-label="Bordkasse-Startseite"
          className="hidden h-10 w-10 shrink-0 items-center justify-center sm:flex"
        >
          <Image
            src="/logo.png"
            alt="Bordkasse"
            width={40}
            height={31}
            className="h-8 w-auto"
          />
        </Link>
        <Link
          href={`/trips/${tripId}/settings`}
          aria-label="Einstellungen (Crew & Kategorien)"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-paper-soft hover:text-primary"
        >
          <SettingsIcon className="h-5 w-5" />
        </Link>
      </div>
    </header>
  );
}
