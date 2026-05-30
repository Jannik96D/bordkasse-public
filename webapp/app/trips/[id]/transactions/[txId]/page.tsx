import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft, Pencil } from "lucide-react";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { isAdmin } from "@/lib/auth/authz";
import { getTransactionDetail } from "@/lib/queries/transactions";
import { getTripMembers } from "@/lib/queries/trips";
import { CategoryIcon } from "@/components/category-icon";
import { InfoTooltip } from "@/components/info-tooltip";
import { formatDate, formatEuro } from "@/lib/utils";

const SPLIT_LABEL = {
  equal: "Gleichmäßig",
  on_board: "An Bord",
  time_proportional: "Zeitanteilig",
  individual: "Individuell",
  per_person: "Pro Person",
} as const;

const SPLIT_HINT = {
  equal: "Alle Crew-Mitglieder zahlen gleich viel, unabhängig von Anwesenheit.",
  on_board: "Nur Personen, die am Tag der Ausgabe an Bord waren, zahlen mit.",
  time_proportional: "Anteil proportional zu den Bord-Tagen pro Person.",
  individual: "Nur die markierten Personen zahlen — alle gleich viel.",
  per_person: "Jede Person zahlt einen eigenen Betrag (z. B. Restaurant).",
} as const;

export default async function TransactionDetailPage({
  params,
}: {
  params: Promise<{ id: string; txId: string }>;
}) {
  const { id: tripId, txId } = await params;
  const person = await getCurrentPerson();
  if (!person) redirect(`/login?redirect=/trips/${tripId}/transactions`);

  const [detail, members, admin] = await Promise.all([
    getTransactionDetail(txId, tripId),
    getTripMembers(tripId),
    isAdmin(),
  ]);
  if (!detail) notFound();

  // Wer darf bearbeiten? Skipper / Co-Skipper / Admin / Ersteller (analog Edit-Page).
  const myMember = members.find((m) => m.person_id === person.id);
  const isMyTripSkipper = !!myMember?.is_skipper;
  const isCreator = detail.created_by_id === person.id;
  const canEdit = isMyTripSkipper || admin || isCreator;

  const isExpense = detail.type === "expense";
  const total = isExpense ? detail.amount + detail.tip_amount : detail.amount;

  return (
    <main>
      <header className="sticky top-0 z-10 border-b border-rule bg-paper/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-md items-center gap-2 px-4 py-3">
          <Link
            href={`/trips/${tripId}/transactions`}
            className="flex h-10 w-10 items-center justify-center rounded-full text-ink-soft hover:bg-paper-soft hover:text-primary"
            aria-label="Zurück zur Liste"
          >
            <ChevronLeft className="h-5 w-5" />
          </Link>
          <h1 className="flex-1 truncate text-xl font-bold text-primary">
            {isExpense ? "Ausgabe" : "Gutschrift"}
          </h1>
          {canEdit && (
            <Link
              href={`/trips/${tripId}/transactions/${txId}/edit`}
              className="inline-flex h-10 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-primary hover:bg-paper-soft"
            >
              <Pencil className="h-4 w-4" />
              Bearbeiten
            </Link>
          )}
        </div>
      </header>

      <div className="mx-auto max-w-md px-4 py-6">
      <section className="space-y-4 rounded-md border border-rule bg-paper p-4">
        <div>
          <h2 className="text-lg font-semibold text-primary">
            {detail.description ?? (isExpense ? "(ohne Beschreibung)" : "Gutschrift")}
          </h2>
          <p className="mt-1 text-sm text-ink-soft">{formatDate(detail.date)}</p>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <Field label="Betrag">
            <p className="text-lg font-semibold text-primary">{formatEuro(total)}</p>
            {detail.tip_amount > 0 && (
              <p className="mt-0.5 text-xs text-ink-soft">
                {formatEuro(detail.amount)} + {formatEuro(detail.tip_amount)} Trinkgeld
              </p>
            )}
            {detail.alcohol_amount > 0 && (
              <p className="mt-0.5 text-xs text-ink-soft">
                davon 🍷 {formatEuro(detail.alcohol_amount)} Alkohol
              </p>
            )}
          </Field>

          {isExpense ? (
            <Field label="Bezahlt von">
              <p className="font-medium">{detail.paid_by_name ?? "?"}</p>
            </Field>
          ) : (
            <Field label="Zahlt">
              <p className="font-medium">{detail.credit_from_name ?? "?"}</p>
            </Field>
          )}

          {isExpense && detail.category_name && (
            <Field label="Kategorie">
              <p className="inline-flex items-center gap-1.5 font-medium">
                <CategoryIcon icon={detail.category_icon} name={detail.category_name} className="h-4 w-4 text-primary" />
                {detail.category_name}
              </p>
            </Field>
          )}

          {isExpense && detail.split_type && (
            <Field label="Aufteilung">
              <p className="font-medium">{SPLIT_LABEL[detail.split_type]}</p>
              <p className="mt-0.5 text-xs text-ink-soft">{SPLIT_HINT[detail.split_type]}</p>
            </Field>
          )}

          {!isExpense && (
            <Field label="Empfänger">
              <p className="font-medium">
                {detail.credit_to_name ?? "Alle Crew-Mitglieder anteilig"}
                {detail.credit_to_id == null && (
                  <InfoTooltip
                    label="Was bedeutet „An Alle“?"
                    text="Der Betrag wird gleichmäßig auf alle Crew-Mitglieder außer den Zahler verteilt."
                  />
                )}
              </p>
            </Field>
          )}
        </div>

        {detail.created_by_name && (
          <p className="border-t border-rule pt-3 text-xs text-ink-soft">
            Eingetragen von <span className="font-medium text-ink">{detail.created_by_name}</span>
          </p>
        )}
      </section>

      {isExpense && (
        <section className="mt-6">
          <h3 className="mb-2 text-sm font-semibold text-primary">Anteil pro Person</h3>
          <p className="mb-3 text-xs text-ink-soft">
            So verteilt sich der Betrag laut Aufteilung „{SPLIT_LABEL[detail.split_type!]}“
            {detail.tip_amount > 0 ? " inkl. Trinkgeld" : ""}
            {detail.alcohol_amount > 0 ? " inkl. Alkohol-Modifikator" : ""}
            .
          </p>
          <ul className="space-y-1.5 rounded-md border border-rule bg-paper p-3">
            {detail.shares
              .slice()
              .sort((a, b) => b.share - a.share)
              .map((s) => {
                const isPaidBy = s.person_id === detail.paid_by_id;
                const hasShare = s.share > 0;
                return (
                  <li
                    key={s.person_id}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span className={hasShare ? "" : "text-ink-soft"}>
                      {s.display_name}
                      {isPaidBy && (
                        <span className="ml-2 rounded-full bg-navy-light/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                          hat bezahlt
                        </span>
                      )}
                      {s.is_alcoholic && detail.alcohol_amount > 0 && (
                        <span
                          className="ml-1 text-xs"
                          title="Trinker — bekommt Alkohol-Anteil"
                          aria-label="Trinker"
                        >
                          🍷
                        </span>
                      )}
                    </span>
                    <span className={hasShare ? "font-semibold tabular-nums" : "tabular-nums text-ink-soft"}>
                      {hasShare ? formatEuro(s.share) : "—"}
                    </span>
                  </li>
                );
              })}
          </ul>
          {detail.split_type === "per_person" && (
            <p className="mt-2 text-xs text-ink-soft">
              Pro-Person-Beträge:{" "}
              {detail.shares
                .filter((s) => s.is_participant && (s.participant_amount ?? 0) > 0)
                .map((s) => `${s.display_name} ${formatEuro(s.participant_amount ?? 0)}`)
                .join(" · ")}
              {detail.tip_amount > 0 &&
                ` (+ ${formatEuro(detail.tip_amount)} Trinkgeld ${detail.tip_distribution === "equal" ? "gleich pro Beteiligter" : "proportional"} verteilt)`}
            </p>
          )}
        </section>
      )}

      </div>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-ink-soft">{label}</p>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}
