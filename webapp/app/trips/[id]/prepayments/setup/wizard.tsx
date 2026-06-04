"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, UserPlus } from "lucide-react";
import { savePrepaymentPlan, saveTranches } from "@/lib/actions/prepayments";
import { inviteMember } from "@/lib/actions/trip-members";
import { defaultWhatsappTemplate } from "@/lib/prepayments/whatsapp";
import { formatEuro, todayIso } from "@/lib/utils";
import { InfoTooltip } from "@/components/info-tooltip";
import { tripVocab, type TripType, type TripVocab } from "@/lib/trip-vocab";
import type {
  PrepaymentPlan,
  CabinType,
  Tranche,
  Obligation,
} from "@/lib/queries/prepayments";
import type { PrepaymentSplitMethod } from "@/lib/validation/prepayment-schema";

interface MemberLite { id: string; display_name: string }

interface Props {
  tripId: string;
  tripType?: TripType;
  members: MemberLite[];
  plan: PrepaymentPlan | null;
  cabins: CabinType[];
  tranches: Tranche[];
  obligations: Obligation[];
}

interface CabinDraft {
  /** Stable Client-ID: für neue Kojen client-seitig per crypto.randomUUID() generiert,
   *  bestehende DB-Kojen erben ihre echte UUID. Wird im Cabin-Dropdown als value verwendet. */
  id: string;
  label: string;
  price_per_person: string;
  capacity: string;
}

interface TrancheDraft {
  id?: string;
  due_date: string;
  label: string;
  percent: string;
}

export function PrepaymentWizard({ tripId, tripType = "sailing", members, plan, cabins, tranches, obligations }: Props) {
  const vocab = tripVocab(tripType);
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [splitMethod, setSplitMethod] = useState<PrepaymentSplitMethod>(plan?.split_method ?? "kojen");
  const [totalAmount, setTotalAmount] = useState(plan?.total_amount.toFixed(2).replace(".", ",") ?? "");
  const [advancerId, setAdvancerId] = useState<string>(plan?.advancer_person_id ?? "");
  const [weroId, setWeroId] = useState(plan?.wero_id ?? "");
  const [whatsappTemplate, setWhatsappTemplate] = useState(plan?.whatsapp_template ?? defaultWhatsappTemplate(vocab));

  // Cabin-Drafts: neue Kojen bekommen client-seitig eine UUID, damit der
  // Dropdown sie eindeutig identifizieren kann (sonst kollidieren alle neuen
  // Kojen mit "value=''" und sind nicht zuordnenbar). Der Server nimmt die
  // ID per UPSERT, neue Rows werden mit dieser ID eingefügt.
  const [cabinDrafts, setCabinDrafts] = useState<CabinDraft[]>(
    cabins.length > 0
      ? cabins.map((c) => ({ id: c.id, label: c.label, price_per_person: c.price_per_person.toFixed(2).replace(".", ","), capacity: String(c.capacity) }))
      : [{ id: crypto.randomUUID(), label: vocab.cabinDefaultLabel, price_per_person: "", capacity: "2" }],
  );

  // Cabin-/Manual-Assignment pro Crew-Member
  const [memberCabin, setMemberCabin] = useState<Record<string, string | "">>(() => {
    const m: Record<string, string | ""> = {};
    for (const o of obligations) m[o.person_id] = o.cabin_type_id ?? "";
    return m;
  });
  const [memberManual, setMemberManual] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const o of obligations) m[o.person_id] = o.total_amount.toFixed(2).replace(".", ",");
    return m;
  });

  // Tranchen
  const [trancheDrafts, setTrancheDrafts] = useState<TrancheDraft[]>(
    tranches.length > 0
      ? tranches.map((t) => ({
          id: t.id,
          due_date: t.due_date,
          label: t.label,
          percent: t.percent.toString().replace(".", ","),
        }))
      : [
          // Labels werden beim Speichern automatisch aus der Position abgeleitet
          // (siehe trancheLabel) — hier nur Platzhalter.
          { due_date: todayIso(), label: "1. Anzahlung", percent: "30" },
          { due_date: todayIso(), label: "Endzahlung", percent: "70" },
        ],
  );

  const percentSum = useMemo(
    () => trancheDrafts.reduce((s, t) => s + Number(t.percent.replace(",", ".") || 0), 0),
    [trancheDrafts],
  );

  // Bei „gleichmäßig"/„zeitanteilig" wird das Soll aus der Gesamtsumme
  // berechnet — ohne Betrag > 0 wäre alles 0. „individuell"/„kojen" leiten das
  // Soll aus Einzel-/Kojenpreisen ab, da darf die Gesamtsumme leer bleiben.
  const needsTotalAmount = splitMethod === "gleichmaessig" || splitMethod === "zeitanteilig";
  const totalAmountNum = Number(totalAmount.replace(",", ".")) || 0;
  const percentValid = Math.abs(percentSum - 100) <= 0.01;

  // Tranchen werden automatisch durchnummeriert (schlankes Design, kein freies
  // Label-Tippen): alle bis auf die letzte heißen „N. Anzahlung", die letzte
  // „Endzahlung". Bei nur einer Tranche → „Endzahlung".
  const trancheLabel = (index: number, total: number) =>
    index === total - 1 ? "Endzahlung" : `${index + 1}. Anzahlung`;

  function savePlan(onSuccess?: () => void) {
    setError(null);
    const obligationsPayload = members.map((m) => {
      if (splitMethod === "kojen") {
        return { person_id: m.id, total_amount: 0, cabin_type_id: memberCabin[m.id] || null };
      }
      if (splitMethod === "individuell") {
        return { person_id: m.id, total_amount: Number((memberManual[m.id] ?? "0").replace(",", ".")) || 0 };
      }
      return { person_id: m.id, total_amount: 0 };
    });

    const payload = {
      trip_id: tripId,
      split_method: splitMethod,
      total_amount: Number(totalAmount.replace(",", ".")) || 0,
      advancer_person_id: advancerId || null,
      wero_id: weroId || "",
      whatsapp_template: whatsappTemplate || "",
      cabin_types: splitMethod === "kojen"
        ? cabinDrafts.map((c, i) => ({
            id: c.id,
            label: c.label,
            price_per_person: Number(c.price_per_person.replace(",", ".")) || 0,
            capacity: Number(c.capacity) || 1,
            sort_order: i,
          }))
        : [],
      obligations: obligationsPayload,
    };

    const fd = new FormData();
    fd.set("payload", JSON.stringify(payload));

    startTransition(async () => {
      const res = await savePrepaymentPlan({ status: "idle" }, fd);
      if (res.status === "error") {
        setError(res.message);
      } else {
        onSuccess?.();
      }
    });
  }

  function saveTranchesAndFinish() {
    setError(null);
    if (Math.abs(percentSum - 100) > 0.01) {
      setError(`Summe aller Tranchenprozente muss 100 % ergeben (aktuell: ${percentSum.toFixed(1)} %).`);
      return;
    }
    const payload = {
      trip_id: tripId,
      tranches: trancheDrafts.map((t, i) => ({
        id: t.id,
        due_date: t.due_date,
        // Label automatisch aus der Position ableiten (durchnummeriert).
        label: trancheLabel(i, trancheDrafts.length),
        percent: Number(t.percent.replace(",", ".")),
        wero_request_link: "",
        sort_order: i,
      })),
    };
    const fd = new FormData();
    fd.set("payload", JSON.stringify(payload));
    startTransition(async () => {
      const res = await saveTranches({ status: "idle" }, fd);
      if (res.status === "error") {
        setError(res.message);
      } else {
        router.push(`/trips/${tripId}/prepayments`);
        router.refresh();
      }
    });
  }

  // Live-Preview der Kojen-Belegung
  const cabinCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const m of members) {
      const cid = memberCabin[m.id];
      if (cid) c[cid] = (c[cid] ?? 0) + 1;
    }
    return c;
  }, [memberCabin, members]);

  // Σ der zugeordneten Kojenpreise — wird gegen die Gesamtsumme geprüft, damit
  // der Skipper merkt, wenn die Kojen nicht die ganze Anzahlung abdecken (Rest
  // landet sonst stillschweigend in der Bordkasse).
  const cabinSum = useMemo(() => {
    const priceById = new Map(
      cabinDrafts.map((c) => [c.id, Number((c.price_per_person || "0").replace(",", ".")) || 0]),
    );
    return members.reduce((s, m) => s + (priceById.get(memberCabin[m.id] ?? "") ?? 0), 0);
  }, [cabinDrafts, memberCabin, members]);

  return (
    <div className="space-y-4">
      <ol className="flex items-center gap-3 text-sm">
        <li className={step === 1 ? "font-semibold text-primary" : "text-ink-soft"}>1. Aufteilung</li>
        <li className="text-ink-soft">→</li>
        <li className={step === 2 ? "font-semibold text-primary" : "text-ink-soft"}>2. Tranchen</li>
      </ol>

      {step === 1 && (
        <section className="space-y-4 rounded-lg border border-rule bg-paper p-5">
          <label className="block text-sm">
            <span className="text-ink-soft">Gesamtsumme der Anzahlung (€)</span>
            <input
              inputMode="decimal"
              value={totalAmount}
              onChange={(e) => setTotalAmount(e.target.value)}
              placeholder="z.B. 3.700,00"
              className="mt-1 w-full rounded-md border border-rule px-3 py-2 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </label>

          <label className="block text-sm">
            <span className="text-ink-soft">
              Aufteilungsmethode
              <InfoTooltip
                label="Wie werden die Sollbeträge berechnet?"
                text={`Bei „Gleichmäßig“ und „Zeitanteilig“ werden die Sollbeträge automatisch aus der Gesamtsumme und der Anwesenheit der ${vocab.crew} berechnet. Bei „Individuell“ und „Nach Kojen“ gibst du sie pro Person bzw. pro Koje vor.`}
              />
            </span>
            <select
              value={splitMethod}
              onChange={(e) => setSplitMethod(e.target.value as PrepaymentSplitMethod)}
              className="mt-1 w-full rounded-md border border-rule px-3 py-2"
            >
              <option value="gleichmaessig">Gleichmäßig auf alle</option>
              <option value="zeitanteilig">Zeitanteilig (nach Bordtagen)</option>
              <option value="individuell">Individuell (pro Person)</option>
              <option value="kojen">Nach {vocab.cabinPlural}</option>
            </select>
          </label>

          {splitMethod === "kojen" && (
            <div className="space-y-3">
              <p className="text-sm font-medium text-primary">{vocab.cabinPlural}typen</p>
              {cabinDrafts.map((c, idx) => (
                <div key={idx} className="grid grid-cols-1 gap-2 sm:grid-cols-12 sm:items-end">
                  <label className="col-span-5 text-sm">
                    <span className="text-xs text-ink-soft">Label</span>
                    <input
                      value={c.label}
                      onChange={(e) => setCabinDrafts(cabinDrafts.map((x, i) => (i === idx ? { ...x, label: e.target.value } : x)))}
                      className="mt-1 w-full rounded-md border border-rule px-2 py-1.5"
                    />
                  </label>
                  <label className="col-span-4 text-sm">
                    <span className="text-xs text-ink-soft">€ pro Person</span>
                    <input
                      inputMode="decimal"
                      value={c.price_per_person}
                      onChange={(e) => setCabinDrafts(cabinDrafts.map((x, i) => (i === idx ? { ...x, price_per_person: e.target.value } : x)))}
                      className="mt-1 w-full rounded-md border border-rule px-2 py-1.5"
                    />
                  </label>
                  <label className="col-span-2 text-sm">
                    <span className="text-xs text-ink-soft">Plätze</span>
                    <input
                      type="number"
                      min={1}
                      value={c.capacity}
                      onChange={(e) => setCabinDrafts(cabinDrafts.map((x, i) => (i === idx ? { ...x, capacity: e.target.value } : x)))}
                      className="mt-1 w-full rounded-md border border-rule px-2 py-1.5"
                    />
                  </label>
                  <button
                    onClick={() => setCabinDrafts(cabinDrafts.filter((_, i) => i !== idx))}
                    className="col-span-1 inline-flex h-9 min-h-touch min-w-touch items-center justify-center justify-self-end rounded-md border border-rule text-ink-soft hover:text-danger sm:justify-self-auto"
                    title="Entfernen"
                    type="button"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setCabinDrafts([...cabinDrafts, { id: crypto.randomUUID(), label: "", price_per_person: "", capacity: "2" }])}
                className="inline-flex items-center gap-1 rounded-md border border-rule px-3 py-1.5 text-sm hover:border-primary/40"
              >
                <Plus className="h-4 w-4" /> {vocab.cabin} hinzufügen
              </button>

              <p className="text-sm font-medium text-primary">Zuordnung {vocab.crew} → {vocab.cabin}</p>
              <CrewQuickAdd tripId={tripId} memberCount={members.length} vocab={vocab} />
              <ul className="space-y-2">
                {members.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-3 rounded-md border border-rule px-3 py-2 text-sm">
                    <span className="font-medium">{m.display_name}</span>
                    <select
                      value={memberCabin[m.id] ?? ""}
                      onChange={(e) => setMemberCabin({ ...memberCabin, [m.id]: e.target.value })}
                      className="rounded-md border border-rule px-2 py-1"
                    >
                      <option value="">— keine —</option>
                      {cabinDrafts.map((c, i) => (
                        <option key={c.id} value={c.id}>
                          {c.label || `${vocab.cabin} ${i + 1}`} {c.price_per_person ? `(${c.price_per_person} €)` : ""}
                        </option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>

              {Object.entries(cabinCounts).length > 0 && (
                <ul className="text-xs text-ink-soft">
                  {cabinDrafts.map((c) => {
                    const used = cabinCounts[c.id] ?? 0;
                    const over = used > Number(c.capacity);
                    return (
                      <li key={c.id} className={over ? "text-danger" : undefined}>
                        {c.label || `(${vocab.cabin})`}: {used} / {c.capacity} belegt {over && " — Überbelegung!"}
                      </li>
                    );
                  })}
                </ul>
              )}

              {/* Nicht-blockierender Hinweis: weichen Σ Kojen und Gesamtsumme
                  ab, landet die Differenz in der Bordkasse statt im Anzahlungs-
                  Pool. Nur zeigen, wenn eine Gesamtsumme gesetzt ist. */}
              {totalAmountNum > 0 && Math.abs(cabinSum - totalAmountNum) > 0.005 && (
                <p className="rounded-md border border-gold/30 bg-gold-soft px-3 py-2 text-xs text-ink" role="status">
                  Σ {vocab.cabinPlural} {formatEuro(cabinSum)} weicht von der Gesamtsumme {formatEuro(totalAmountNum)} ab
                  {cabinSum < totalAmountNum
                    ? ` — die Differenz läuft über die ${vocab.kitty}.`
                    : ` — die ${vocab.cabinPlural} übersteigen die Gesamtsumme, bitte Preise prüfen.`}
                </p>
              )}
            </div>
          )}

          {splitMethod === "individuell" && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-primary">Soll pro Person</p>
              <CrewQuickAdd tripId={tripId} memberCount={members.length} vocab={vocab} />
              {members.map((m) => (
                <label key={m.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium">{m.display_name}</span>
                  <input
                    inputMode="decimal"
                    value={memberManual[m.id] ?? ""}
                    onChange={(e) => setMemberManual({ ...memberManual, [m.id]: e.target.value })}
                    placeholder="€"
                    className="w-32 rounded-md border border-rule px-2 py-1 text-right"
                  />
                </label>
              ))}
              <p className="text-xs text-ink-soft">
                Summe: <strong>{formatEuro(Object.values(memberManual).reduce((s, v) => s + (Number(v.replace(",", ".")) || 0), 0))}</strong>
              </p>
            </div>
          )}

          {(splitMethod === "gleichmaessig" || splitMethod === "zeitanteilig") && (
            <div className="space-y-3">
              <CrewQuickAdd tripId={tripId} memberCount={members.length} vocab={vocab} />
            </div>
          )}

          <label className="block text-sm">
            <span className="text-ink-soft">
              Wer streckt vor?
              <InfoTooltip
                label="Wer streckt vor?"
                text={`Wer die ${vocab.prepayment} ${tripType === "other" ? "an den Anbieter" : "an die Charteragentur"} vorstreckt. Alle Anzahlungen der ${vocab.crew} werden an diese Person verbucht; ihren eigenen Anteil kann sie bilanzneutral als Selbstverrechnung abhaken. Default ist ${vocab.skipper === "Skipper" ? "der Törn-Skipper" : "die Reiseleitung"}.`}
              />
            </span>
            <select
              value={advancerId}
              onChange={(e) => setAdvancerId(e.target.value)}
              className="mt-1 w-full rounded-md border border-rule px-3 py-2"
            >
              <option value="">— {vocab.skipper === "Skipper" ? "Törn-Skipper" : "Reiseleitung"} (Default) —</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>{m.display_name}</option>
              ))}
            </select>
          </label>

          <label className="block text-sm">
            <span className="text-ink-soft">Wero-ID (optional)</span>
            <input
              value={weroId}
              onChange={(e) => setWeroId(e.target.value)}
              placeholder="z.B. +49…oder skipper@example.com"
              className="mt-1 w-full rounded-md border border-rule px-3 py-2"
            />
          </label>

          <details className="text-sm">
            <summary className="cursor-pointer text-ink-soft">WhatsApp-Vorlage</summary>
            <textarea
              value={whatsappTemplate}
              onChange={(e) => setWhatsappTemplate(e.target.value)}
              rows={10}
              className="mt-2 w-full rounded-md border border-rule p-3 font-mono text-xs"
            />
            <p className="mt-1 text-xs text-ink-soft">
              Platzhalter: {`{{name}}, {{tranche_label}}, {{trip_name}}, {{amount}}, {{due_date}}, {{wero_link_or_id}}`}
              <InfoTooltip
                label="Hinweis zum Wero-Platzhalter"
                text="{{wero_link_or_id}} fällt automatisch auf die Wero-ID zurück, da Wero aktuell keine öffentliche Schnittstelle für Klick-Links bereitstellt."
              />
            </p>
          </details>

          {error && <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

          {needsTotalAmount && totalAmountNum <= 0 && (
            <p className="text-xs text-ink-soft">
              Trage zuerst eine Gesamtsumme &gt; 0 € ein. Daraus werden die
              Sollbeträge der Crew berechnet.
            </p>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              disabled={pending || (needsTotalAmount && totalAmountNum <= 0)}
              onClick={() => savePlan(() => setStep(2))}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-paper hover:bg-navy-dark disabled:opacity-50"
            >
              Speichern & weiter zu Tranchen
            </button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="space-y-3 rounded-lg border border-rule bg-paper p-5">
          <p className="text-sm text-ink-soft">
            Definiere, wann welcher Anteil fällig ist. Summe muss 100 % ergeben.
          </p>
          {trancheDrafts.map((t, idx) => (
            <div key={idx} className="grid grid-cols-1 gap-2 sm:grid-cols-12 sm:items-end">
              <div className="text-sm sm:col-span-4">
                <span className="text-xs text-ink-soft">Bezeichnung</span>
                <p className="mt-1 truncate py-1.5 font-medium text-primary">
                  {trancheLabel(idx, trancheDrafts.length)}
                </p>
              </div>
              <label className="text-sm sm:col-span-4">
                <span className="text-xs text-ink-soft">Fällig am</span>
                <input
                  type="date"
                  value={t.due_date}
                  onChange={(e) => setTrancheDrafts(trancheDrafts.map((x, i) => (i === idx ? { ...x, due_date: e.target.value } : x)))}
                  className="mt-1 w-full rounded-md border border-rule px-2 py-1.5"
                />
              </label>
              <label className="text-sm sm:col-span-3">
                <span className="text-xs text-ink-soft">Anteil %</span>
                <input
                  inputMode="decimal"
                  value={t.percent}
                  onChange={(e) => setTrancheDrafts(trancheDrafts.map((x, i) => (i === idx ? { ...x, percent: e.target.value } : x)))}
                  className="mt-1 w-full rounded-md border border-rule px-2 py-1.5"
                />
              </label>
              <button
                onClick={() => setTrancheDrafts(trancheDrafts.filter((_, i) => i !== idx))}
                className="col-span-1 inline-flex h-9 min-h-touch min-w-touch items-center justify-center justify-self-end rounded-md border border-rule text-ink-soft hover:text-danger sm:justify-self-auto"
                title="Entfernen"
                type="button"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setTrancheDrafts([...trancheDrafts, { due_date: todayIso(), label: "", percent: "0" }])}
            className="inline-flex items-center gap-1 rounded-md border border-rule px-3 py-1.5 text-sm hover:border-primary/40"
          >
            <Plus className="h-4 w-4" /> Tranche hinzufügen
          </button>

          <p className={`text-sm ${Math.abs(percentSum - 100) > 0.01 ? "text-danger" : "text-ink-soft"}`}>
            Summe: <strong>{percentSum.toFixed(1)} %</strong> (muss 100 % ergeben)
          </p>

          {error && <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="rounded-md border border-rule px-4 py-2 text-sm hover:bg-navy-light/30"
            >
              Zurück
            </button>
            <button
              type="button"
              disabled={pending || trancheDrafts.length === 0 || !percentValid}
              onClick={saveTranchesAndFinish}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-paper hover:bg-navy-dark disabled:opacity-50"
            >
              Fertig stellen
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// CrewQuickAdd — Inline-Anlage neuer Crew direkt im Wizard.
// Spart den Detour über Settings, wenn der Skipper den Anzahlungsplan
// noch vor dem eigentlichen Crew-Onboarding erstellt.
// ────────────────────────────────────────────────────────────────────────
function CrewQuickAdd({ tripId, memberCount, vocab }: { tripId: string; memberCount: number; vocab: TripVocab }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function add() {
    setError(null);
    setSuccess(null);
    setWarning(null);
    if (!name.trim() && !email.trim()) {
      setError("Mindestens Name oder E-Mail angeben.");
      return;
    }
    const fd = new FormData();
    fd.set("trip_id", tripId);
    fd.set("email", email.trim());
    fd.set("display_name", name.trim());
    startTransition(async () => {
      const res = await inviteMember({ status: "idle" }, fd);
      if (res.status === "error") {
        setError(res.message);
      } else {
        setSuccess(`„${name.trim() || email.trim()}" hinzugefügt.`);
        if (res.status === "ok" && res.warning) setWarning(res.warning);
        setName("");
        setEmail("");
        // Server-Component neu rendern lassen, damit der neue Member
        // in der Zuordnungs-Liste + Vorstrecker-Dropdown erscheint.
        router.refresh();
      }
    });
  }

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      className="rounded-md border border-dashed border-primary/30 bg-navy-light/20 p-3 text-sm"
    >
      <summary className="cursor-pointer text-primary">
        <UserPlus className="mr-1 inline h-4 w-4" />
        {vocab.addMember}
        <span className="ml-2 text-xs font-normal text-ink-soft">(aktuell {memberCount})</span>
      </summary>
      <div className="mt-3 space-y-2">
        <label className="block">
          <span className="text-xs text-ink-soft">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="z.B. Lucas"
            className="mt-1 w-full rounded-md border border-rule bg-paper px-3 py-1.5"
          />
        </label>
        <label className="block">
          <span className="text-xs text-ink-soft">E-Mail (optional, ermöglicht Login)</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="lucas@example.com"
            className="mt-1 w-full rounded-md border border-rule bg-paper px-3 py-1.5"
          />
        </label>
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        {success && <p role="status" className="text-xs text-success">{success}</p>}
        {warning && (
          <p role="status" className="rounded-md border border-gold/30 bg-gold-soft px-2 py-1 text-xs text-ink">
            ⚠ {warning}
          </p>
        )}
        <button
          type="button"
          onClick={add}
          disabled={pending}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-paper hover:bg-navy-dark disabled:opacity-50"
        >
          {pending ? "Lege an …" : `${vocab.crew} hinzufügen`}
        </button>
        <p className="text-xs text-ink-soft">
          Ohne E-Mail wird die Person als Ghost angelegt (kein Login, aber Anzahlungssoll und WhatsApp-Texte gehen trotzdem).
        </p>
      </div>
    </details>
  );
}
