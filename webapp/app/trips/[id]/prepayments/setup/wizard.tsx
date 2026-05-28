"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { savePrepaymentPlan, saveTranches } from "@/lib/actions/prepayments";
import { DEFAULT_WHATSAPP_TEMPLATE } from "@/lib/prepayments/whatsapp";
import { formatEuro, todayIso } from "@/lib/utils";
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
  wero_request_link: string;
}

export function PrepaymentWizard({ tripId, members, plan, cabins, tranches, obligations }: Props) {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [splitMethod, setSplitMethod] = useState<PrepaymentSplitMethod>(plan?.split_method ?? "kojen");
  const [totalAmount, setTotalAmount] = useState(plan?.total_amount.toFixed(2).replace(".", ",") ?? "");
  const [weroId, setWeroId] = useState(plan?.wero_id ?? "");
  const [whatsappTemplate, setWhatsappTemplate] = useState(plan?.whatsapp_template ?? DEFAULT_WHATSAPP_TEMPLATE);

  // Cabin-Drafts: neue Kojen bekommen client-seitig eine UUID, damit der
  // Dropdown sie eindeutig identifizieren kann (sonst kollidieren alle neuen
  // Kojen mit "value=''" und sind nicht zuordnenbar). Der Server nimmt die
  // ID per UPSERT, neue Rows werden mit dieser ID eingefügt.
  const [cabinDrafts, setCabinDrafts] = useState<CabinDraft[]>(
    cabins.length > 0
      ? cabins.map((c) => ({ id: c.id, label: c.label, price_per_person: c.price_per_person.toFixed(2).replace(".", ","), capacity: String(c.capacity) }))
      : [{ id: crypto.randomUUID(), label: "Doppelkoje", price_per_person: "", capacity: "2" }],
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
          wero_request_link: t.wero_request_link ?? "",
        }))
      : [
          { due_date: todayIso(), label: "Reservierungs-Anzahlung", percent: "30", wero_request_link: "" },
          { due_date: todayIso(), label: "Endzahlung", percent: "70", wero_request_link: "" },
        ],
  );

  const percentSum = useMemo(
    () => trancheDrafts.reduce((s, t) => s + Number(t.percent.replace(",", ".") || 0), 0),
    [trancheDrafts],
  );

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
      setError(`Summe aller Tranchen-Prozente muss 100 % ergeben (aktuell: ${percentSum.toFixed(1)} %).`);
      return;
    }
    const payload = {
      trip_id: tripId,
      tranches: trancheDrafts.map((t, i) => ({
        id: t.id,
        due_date: t.due_date,
        label: t.label,
        percent: Number(t.percent.replace(",", ".")),
        wero_request_link: t.wero_request_link || "",
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
            <span className="text-ink-soft">Aufteilungs-Methode</span>
            <select
              value={splitMethod}
              onChange={(e) => setSplitMethod(e.target.value as PrepaymentSplitMethod)}
              className="mt-1 w-full rounded-md border border-rule px-3 py-2"
            >
              <option value="gleichmaessig">Gleichmäßig auf alle</option>
              <option value="zeitanteilig">Zeitanteilig (nach Bord-Tagen)</option>
              <option value="individuell">Individuell (pro Person)</option>
              <option value="kojen">Nach Kojen</option>
            </select>
          </label>

          {splitMethod === "kojen" && (
            <div className="space-y-3">
              <p className="text-sm font-medium text-primary">Kojen-Typen</p>
              {cabinDrafts.map((c, idx) => (
                <div key={idx} className="grid grid-cols-12 items-end gap-2">
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
                    className="col-span-1 inline-flex h-9 items-center justify-center rounded-md border border-rule text-ink-soft hover:text-danger"
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
                <Plus className="h-4 w-4" /> Koje hinzufügen
              </button>

              <p className="text-sm font-medium text-primary">Zuordnung Crew → Koje</p>
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
                          {c.label || `Koje ${i + 1}`} {c.price_per_person ? `(${c.price_per_person} €)` : ""}
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
                        {c.label || "(Koje)"}: {used} / {c.capacity} belegt {over && " — Überbelegung!"}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {splitMethod === "individuell" && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-primary">Soll pro Person</p>
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
            <p className="rounded-md bg-paper-soft px-3 py-2 text-sm text-ink-soft">
              Die Soll-Beträge werden automatisch aus der Gesamtsumme und der Crew-Anwesenheit berechnet.
            </p>
          )}

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
            </p>
          </details>

          {error && <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

          <div className="flex justify-end">
            <button
              type="button"
              disabled={pending}
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
            <div key={idx} className="grid grid-cols-12 items-end gap-2">
              <label className="col-span-3 text-sm">
                <span className="text-xs text-ink-soft">Fällig am</span>
                <input
                  type="date"
                  value={t.due_date}
                  onChange={(e) => setTrancheDrafts(trancheDrafts.map((x, i) => (i === idx ? { ...x, due_date: e.target.value } : x)))}
                  className="mt-1 w-full rounded-md border border-rule px-2 py-1.5"
                />
              </label>
              <label className="col-span-4 text-sm">
                <span className="text-xs text-ink-soft">Label</span>
                <input
                  value={t.label}
                  onChange={(e) => setTrancheDrafts(trancheDrafts.map((x, i) => (i === idx ? { ...x, label: e.target.value } : x)))}
                  className="mt-1 w-full rounded-md border border-rule px-2 py-1.5"
                />
              </label>
              <label className="col-span-2 text-sm">
                <span className="text-xs text-ink-soft">Anteil %</span>
                <input
                  inputMode="decimal"
                  value={t.percent}
                  onChange={(e) => setTrancheDrafts(trancheDrafts.map((x, i) => (i === idx ? { ...x, percent: e.target.value } : x)))}
                  className="mt-1 w-full rounded-md border border-rule px-2 py-1.5"
                />
              </label>
              <label className="col-span-2 text-sm">
                <span className="text-xs text-ink-soft">Wero-Link</span>
                <input
                  value={t.wero_request_link}
                  onChange={(e) => setTrancheDrafts(trancheDrafts.map((x, i) => (i === idx ? { ...x, wero_request_link: e.target.value } : x)))}
                  placeholder="(optional)"
                  className="mt-1 w-full rounded-md border border-rule px-2 py-1.5"
                />
              </label>
              <button
                onClick={() => setTrancheDrafts(trancheDrafts.filter((_, i) => i !== idx))}
                className="col-span-1 inline-flex h-9 items-center justify-center rounded-md border border-rule text-ink-soft hover:text-danger"
                title="Entfernen"
                type="button"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setTrancheDrafts([...trancheDrafts, { due_date: todayIso(), label: "", percent: "0", wero_request_link: "" }])}
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
              disabled={pending}
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
