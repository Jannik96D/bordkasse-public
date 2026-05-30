"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FeatureShot } from "./feature-shot";

export type ExplorerFeature = {
  id: string;
  title: string;
  lead: string;
  body: React.ReactNode;
  screenshot: string;
  alt: string;
};

export type ExplorerPhase = {
  id: string;
  title: string;
  lead: string;
  icon: React.ReactNode;
  features: ExplorerFeature[];
};

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
 * „Mehr Details“ ist progressive disclosure NUR dort, wo der Platz knapp ist:
 * auf Mobile hinter einem `<details>` eingeklappt, auf Desktop direkt neben
 * dem Phone offen.
 *
 * Deep-Links: `#<phaseId>` öffnet die Phase, `#<featureId>` öffnet die
 * passende Phase und scrollt zum Feature. Hash-Änderungen werden live
 * verarbeitet, damit Links von außen (und der Skip-Anker) funktionieren.
 */
export function AboutExplorer({ phases }: { phases: ExplorerPhase[] }) {
  const [active, setActive] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const interacted = useRef(false);

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
      setActive(match.phase);
      if (match.featureId) {
        // Nach dem Render zum Feature scrollen.
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

  function selectPhase(index: number) {
    interacted.current = true;
    setActive(index);
  }

  // Nach einem Tab-Wechsel per Klick/Taste an den Panel-Anfang scrollen,
  // damit man den Beginn der Phase sieht (scroll-mt hält die Sticky-Leiste frei).
  useEffect(() => {
    if (!interacted.current) return;
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [active]);

  // ARIA-Tabs-Tastatursteuerung: Pfeile, Home/End.
  function onTabKeyDown(e: React.KeyboardEvent, index: number) {
    let next = index;
    if (e.key === "ArrowRight") next = (index + 1) % phases.length;
    else if (e.key === "ArrowLeft")
      next = (index - 1 + phases.length) % phases.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = phases.length - 1;
    else return;
    e.preventDefault();
    selectPhase(next);
    tabRefs.current[next]?.focus();
  }

  const phase = phases[active];

  return (
    <div className="mt-8">
      {/* Sticky Phasen-Tabs */}
      <div
        role="tablist"
        aria-label="Funktionen nach Törn-Phase"
        className="sticky top-0 z-30 -mx-6 flex gap-2 overflow-x-auto border-b border-rule bg-paper/90 px-6 py-3 backdrop-blur [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {phases.map((p, i) => {
          const selected = i === active;
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
              tabIndex={selected ? 0 : -1}
              onClick={() => selectPhase(i)}
              onKeyDown={(e) => onTabKeyDown(e, i)}
              className={`flex min-h-touch shrink-0 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper ${
                selected
                  ? "bg-primary text-paper shadow-sm"
                  : "border border-rule bg-paper-soft text-ink-soft hover:text-ink"
              }`}
            >
              <span aria-hidden="true" className="shrink-0">
                {p.icon}
              </span>
              <span className="whitespace-nowrap">{p.title}</span>
              <span
                className={
                  selected ? "text-paper/70" : "text-ink-soft/70"
                }
                aria-hidden="true"
              >
                {p.features.length}
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
          {phase.features.map((f, i) => {
            const phoneRight = i % 2 === 1; // abwechselnd: Phone mal links, mal rechts
            return (
              <li
                key={f.id}
                id={f.id}
                className="scroll-mt-24 md:grid md:grid-cols-2 md:items-center md:gap-10"
              >
                {/* Phone-Frame */}
                <div className={phoneRight ? "md:order-2" : "md:order-1"}>
                  <FeatureShot src={f.screenshot} alt={f.alt} />
                </div>

                {/* Text */}
                <div
                  className={`mt-4 md:mt-0 ${
                    phoneRight ? "md:order-1" : "md:order-2"
                  }`}
                >
                  <h3 className="text-lg font-semibold text-ink">{f.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink">
                    {f.lead}
                  </p>

                  {/* Mobile: eingeklappt hinter „Mehr Details“ */}
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
