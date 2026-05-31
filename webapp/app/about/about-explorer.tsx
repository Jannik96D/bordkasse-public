"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FeatureShot } from "./feature-shot";

/** Für wen ist ein Feature primär relevant? Steuert Badge + Filter. */
export type FeatureRole = "skipper" | "crew" | "alle";

export type ExplorerFeature = {
  id: string;
  title: string;
  lead: string;
  body: React.ReactNode;
  screenshot: string;
  alt: string;
  role: FeatureRole;
};

export type ExplorerPhase = {
  id: string;
  title: string;
  lead: string;
  icon: React.ReactNode;
  features: ExplorerFeature[];
};

type RoleFilter = "alle" | "skipper" | "crew";

const ROLE_BADGE: Record<FeatureRole, { label: string; emoji: string; cls: string }> = {
  skipper: { label: "Skipper", emoji: "⚓", cls: "border-primary/30 bg-navy-light/50 text-primary" },
  crew: { label: "Crew", emoji: "👥", cls: "border-rule bg-paper-soft text-ink" },
  alle: { label: "Alle", emoji: "👥", cls: "border-rule bg-paper-soft text-ink-soft" },
};

const FILTERS: { id: RoleFilter; label: string; emoji?: string }[] = [
  { id: "alle", label: "Alle" },
  { id: "skipper", label: "Nur Skipper", emoji: "⚓" },
  { id: "crew", label: "Nur Crew", emoji: "👥" },
];

/**
 * Ein „Alle"-Feature ist für jede Rolle relevant und bleibt unter jedem
 * Filter sichtbar. „Nur Skipper" / „Nur Crew" blenden lediglich die
 * rollenspezifischen Funktionen der jeweils anderen Seite aus.
 */
function isVisibleUnder(role: FeatureRole, filter: RoleFilter): boolean {
  if (filter === "alle") return true;
  return role === "alle" || role === filter;
}

function RoleBadge({ role }: { role: FeatureRole }) {
  const b = ROLE_BADGE[role];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${b.cls}`}
    >
      <span aria-hidden="true">{b.emoji}</span>
      <span className="sr-only">Für </span>
      {b.label}
    </span>
  );
}

/**
 * About-Seite: Phasen-Explorer.
 *
 * Kombiniert drei Muster, durchgängig responsiv:
 *  1. Alternierendes Zwei-Spalten-Layout pro Feature (ab `md`): Phone-Frame
 *     auf der einen, Text auf der anderen Seite, Seitenwechsel pro Feature.
 *     Auf Mobile gestapelt (Phone zuerst, dann Text).
 *  2. Sticky-Navigation: die Phasen-Leiste bleibt beim Scrollen oben kleben.
 *  3. Tabs: die Leiste schaltet zwischen den Phasen um (eine Phase sichtbar),
 *     statt alles zu einer sehr langen Seite zu stapeln.
 *
 * Rollen-Filter: ein Chip-Filter (Alle · Nur Skipper · Nur Crew) blendet
 * rollenspezifische Funktionen aus; die Tab-Zähler zeigen die gefilterte
 * Anzahl, leere Phasen werden ausgegraut. Jedes Feature trägt ein
 * Rollen-Badge (Text + Emoji, nicht nur Farbe).
 *
 * „Mehr Details" ist progressive disclosure NUR dort, wo der Platz knapp ist:
 * auf Mobile hinter einem `<details>` eingeklappt, auf Desktop direkt neben
 * dem Phone offen.
 *
 * Deep-Links: `#<phaseId>` öffnet die Phase, `#<featureId>` öffnet die
 * passende Phase und scrollt zum Feature. Ein per Deep-Link adressiertes
 * Feature setzt den Filter auf „Alle", damit es garantiert sichtbar ist.
 */
export function AboutExplorer({
  phases,
  intro,
}: {
  phases: ExplorerPhase[];
  intro?: React.ReactNode;
}) {
  const [active, setActive] = useState(0);
  const [filter, setFilter] = useState<RoleFilter>("alle");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const interacted = useRef(false);

  const visibleCount = useCallback(
    (i: number) => phases[i].features.filter((f) => isVisibleUnder(f.role, filter)).length,
    [phases, filter],
  );

  // Screenshots der NACHBARPHASEN (aktive ±1) nach dem ersten Paint in der
  // Idle-Zeit vorladen, damit der Phone-Frame beim Weiterblättern sofort aus
  // dem Cache rendert. Bewusst nicht alle Phasen auf einmal — das spart
  // Bandbreite auf langsamen Verbindungen; ferne Sprünge laden dank kleiner
  // WebP-Dateien trotzdem schnell. Läuft bei jedem Phasenwechsel neu.
  useEffect(() => {
    const neighbours = [active - 1, active + 1].filter(
      (i) => i >= 0 && i < phases.length,
    );
    const urls = neighbours.flatMap((i) =>
      phases[i].features.map((f) => f.screenshot),
    );
    const preload = () => {
      for (const url of urls) {
        const img = new window.Image();
        img.src = url;
      }
    };
    const ric = (
      window as typeof window & {
        requestIdleCallback?: (cb: () => void) => number;
      }
    ).requestIdleCallback;
    if (typeof ric === "function") {
      ric(preload);
    } else {
      const t = window.setTimeout(preload, 200);
      return () => window.clearTimeout(t);
    }
  }, [phases, active]);

  const findPhaseIndexByHash = useCallback(
    (hash: string): { phase: number; featureId: string | null } | null => {
      const id = hash.replace(/^#/, "");
      if (!id) return null;
      const byPhase = phases.findIndex((p) => p.id === id);
      if (byPhase >= 0) return { phase: byPhase, featureId: null };
      const byFeature = phases.findIndex((p) =>
        p.features.some((f) => f.id === id),
      );
      if (byFeature >= 0) return { phase: byFeature, featureId: id };
      return null;
    },
    [phases],
  );

  // Initiale Auswahl + Live-Reaktion auf Hash-Änderungen.
  useEffect(() => {
    function applyHash() {
      const match = findPhaseIndexByHash(window.location.hash);
      if (!match) return;
      // Deep-Link auf ein Feature → Filter zurücksetzen, sonst könnte das
      // Ziel ausgeblendet sein.
      if (match.featureId) setFilter("alle");
      setActive(match.phase);
      if (match.featureId) {
        requestAnimationFrame(() => {
          document.getElementById(match.featureId!)?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        });
      }
    }
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, [findPhaseIndexByHash]);

  // Filter wechseln — wenn die aktuelle Phase darunter leer wäre, direkt auf
  // die erste nicht-leere springen (im Event-Handler, nicht im Effect).
  function changeFilter(next: RoleFilter) {
    setFilter(next);
    const countUnder = (i: number) =>
      phases[i].features.filter((f) => isVisibleUnder(f.role, next)).length;
    if (countUnder(active) === 0) {
      const idx = phases.findIndex((_, i) => countUnder(i) > 0);
      if (idx >= 0) setActive(idx);
    }
  }

  function selectPhase(index: number) {
    interacted.current = true;
    setActive(index);
  }

  // Nach einem Tab-Wechsel per Klick/Taste an den Panel-Anfang scrollen.
  useEffect(() => {
    if (!interacted.current) return;
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [active]);

  // ARIA-Tabs-Tastatursteuerung: Pfeile, Home/End — leere Tabs überspringen.
  function onTabKeyDown(e: React.KeyboardEvent, index: number) {
    const step = (from: number, dir: number) => {
      let n = from;
      for (let k = 0; k < phases.length; k++) {
        n = (n + dir + phases.length) % phases.length;
        if (visibleCount(n) > 0) return n;
      }
      return from;
    };
    let next = index;
    if (e.key === "ArrowRight") next = step(index, 1);
    else if (e.key === "ArrowLeft") next = step(index, -1);
    else if (e.key === "Home") next = phases.findIndex((_, i) => visibleCount(i) > 0);
    else if (e.key === "End")
      next = phases.length - 1 - [...phases].reverse().findIndex((_, i) => visibleCount(phases.length - 1 - i) > 0);
    else return;
    e.preventDefault();
    if (next < 0 || next === index) return;
    selectPhase(next);
    tabRefs.current[next]?.focus();
  }

  const phase = phases[active];
  const visibleFeatures = phase.features.filter((f) => isVisibleUnder(f.role, filter));

  return (
    <div className="mt-8">
      {intro}

      {/* Rollen-Filter */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink-soft">Für wen?</span>
        <div role="group" aria-label="Nach Rolle filtern" className="flex flex-wrap gap-2">
          {FILTERS.map((f) => {
            const on = filter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                aria-pressed={on}
                onClick={() => changeFilter(f.id)}
                className={`inline-flex min-h-touch items-center gap-1 rounded-full px-3 py-1.5 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper ${
                  on
                    ? "bg-primary text-paper shadow-sm"
                    : "border border-rule bg-paper-soft text-ink-soft hover:text-ink"
                }`}
              >
                {f.emoji && <span aria-hidden="true">{f.emoji}</span>}
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Sticky Phasen-Tabs */}
      <div
        role="tablist"
        aria-label="Funktionen nach Törn-Phase"
        className="sticky top-0 z-30 -mx-6 flex gap-2 overflow-x-auto border-b border-rule bg-paper/90 px-6 py-3 backdrop-blur [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {phases.map((p, i) => {
          const selected = i === active;
          const count = visibleCount(i);
          const disabled = count === 0;
          return (
            <button
              key={p.id}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              role="tab"
              id={`tab-${p.id}`}
              aria-selected={selected}
              aria-controls={`panel-${p.id}`}
              aria-disabled={disabled}
              tabIndex={selected ? 0 : -1}
              onClick={() => !disabled && selectPhase(i)}
              onKeyDown={(e) => onTabKeyDown(e, i)}
              className={`flex min-h-touch shrink-0 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper ${
                selected
                  ? "bg-primary text-paper shadow-sm"
                  : disabled
                    ? "border border-rule bg-paper-soft text-ink-soft/40 cursor-not-allowed"
                    : "border border-rule bg-paper-soft text-ink-soft hover:text-ink"
              }`}
            >
              <span aria-hidden="true" className="shrink-0">
                {p.icon}
              </span>
              <span className="whitespace-nowrap">{p.title}</span>
              <span
                className={selected ? "text-paper/70" : "text-ink-soft/70"}
                aria-hidden="true"
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Panel der aktiven Phase */}
      <div
        ref={panelRef}
        role="tabpanel"
        id={`panel-${phase.id}`}
        aria-labelledby={`tab-${phase.id}`}
        tabIndex={0}
        className="scroll-mt-24 pt-8 focus:outline-none"
      >
        <header className="mb-8 border-b border-rule pb-4">
          <h2 className="flex items-center gap-2 text-xl font-bold text-primary">
            <span aria-hidden="true">{phase.icon}</span>
            {phase.title}
          </h2>
          <p className="mt-1 text-sm text-ink-soft">{phase.lead}</p>
        </header>

        <ul className="space-y-14 md:space-y-20">
          {visibleFeatures.map((f, i) => {
            const phoneRight = i % 2 === 1; // abwechselnd: Phone mal links, mal rechts
            return (
              <li
                key={f.id}
                id={f.id}
                className="scroll-mt-24 md:grid md:grid-cols-2 md:items-center md:gap-10"
              >
                {/* Phone-Frame — Top-Bild der Phase eager (LCP) */}
                <div className={phoneRight ? "md:order-2" : "md:order-1"}>
                  <FeatureShot
                    src={f.screenshot}
                    alt={f.alt}
                    priority={i === 0}
                  />
                </div>

                {/* Text */}
                <div
                  className={`mt-4 md:mt-0 ${
                    phoneRight ? "md:order-1" : "md:order-2"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-semibold text-ink">{f.title}</h3>
                    <RoleBadge role={f.role} />
                  </div>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink">
                    {f.lead}
                  </p>

                  {/* Mobile: eingeklappt hinter „Mehr Details" */}
                  <details className="group mt-2 md:hidden">
                    <summary className="cursor-pointer list-none text-sm text-ink-soft hover:text-ink">
                      <span className="group-open:hidden">Mehr Details ›</span>
                      <span className="hidden group-open:inline">
                        ‹ Details schließen
                      </span>
                    </summary>
                    <div className="prose mt-2 max-w-none text-sm leading-relaxed text-ink-soft">
                      {f.body}
                    </div>
                  </details>

                  {/* Desktop: direkt sichtbar (genug Platz neben dem Phone) */}
                  <div className="prose mt-3 hidden max-w-none text-sm leading-relaxed text-ink-soft md:block">
                    {f.body}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
