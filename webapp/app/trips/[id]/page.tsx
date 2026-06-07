import Link from "next/link";
import { Euro, ScaleIcon, Users, Plus, Coins } from "lucide-react";
import { getTrip, getTripMembers } from "@/lib/queries/trips";
import { getPlan } from "@/lib/queries/prepayments";
import { countMyTransactions } from "@/lib/queries/transactions";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { isAdmin } from "@/lib/auth/authz";
import { todayIso } from "@/lib/utils";
import { tripVocab } from "@/lib/trip-vocab";
import { FabAddTransaction } from "@/components/bottom-nav";
import { OnboardingHint } from "@/components/onboarding-hint";
import { SettlementStatus } from "@/components/settlement-status";
import { NotificationNudge } from "@/components/notification-nudge";
import { InAppBrowserWarning } from "@/components/in-app-browser-warning";
import { InstallHint } from "@/components/install-hint";
import { TripProgress } from "@/components/trip-progress";
import { getTripProgressSignals } from "@/lib/queries/trip-progress";
import { computeTripProgress } from "@/lib/calc/trip-progress";

export default async function TripDashboard({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ check_settlement?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const justEditedKaution = sp.check_settlement === "1";
  const [trip, members, person, admin, plan] = await Promise.all([
    getTrip(id),
    getTripMembers(id),
    getCurrentPerson(),
    isAdmin(),
    getPlan(id),
  ]);
  if (!trip) return null;

  const vocab = tripVocab(trip.trip_type);
  const memberCount = members.length;
  const hasMembers = memberCount > 0;
  const myMember = members.find((m) => m.person_id === person?.id);
  const isMyTripSkipper = !!myMember?.is_skipper;
  const canAnnounce = admin || isMyTripSkipper;

  // Anzahlungen sind bewusst aus der Übersicht verbannt — die laufende
  // Verwaltung läuft über den kontextuellen Nav-Eintrag und die
  // Trip-Einstellungen. Einzige Ausnahme: ein Skipper/Admin, der vor
  // Törnstart noch keinen Plan angelegt hat, sieht einen Einstiegs-CTA.
  const tripNotStarted = trip.start_date > todayIso();
  const showCreatePrepaymentCta = canAnnounce && !plan && tripNotStarted;

  // Onboarding-Hinweis aufs „+"-FAB: nur während des aktiven Törns, mit Crew,
  // und nur solange die eingeloggte Person noch keine EIGENE Buchung erfasst
  // hat. Die letzte Bedingung (weggeklickt?) prüft die Client-Komponente.
  const today = todayIso();
  const tripActive = trip.start_date <= today && trip.end_date >= today;
  const onboardingPossible = tripActive && hasMembers && !!person;
  const myBookingCount = onboardingPossible
    ? await countMyTransactions(id, person!.id)
    : 1;
  const onboardingEligible = onboardingPossible && myBookingCount === 0;

  // Törn-Fortschritt-Karte nur für Skipper/Co-Skipper/Admin (wie der Banner).
  let progress = null;
  if (canAnnounce) {
    const signals = await getTripProgressSignals({
      tripId: id,
      startDate: trip.start_date,
      endDate: trip.end_date,
      memberCount,
      settlementAnnounced: !!trip.settlement_announced_at,
      depositSettled: !!trip.deposit_settled_at,
    });
    progress = computeTripProgress(signals, todayIso(), trip.trip_type === "other" ? "other" : "sailing");
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <SettlementStatus
        tripId={id}
        endDate={trip.end_date}
        announcedAt={trip.settlement_announced_at ?? null}
        changesPendingSince={trip.changes_pending_since ?? null}
        lastResendAt={trip.last_settlement_resend_at ?? null}
        canAnnounce={canAnnounce}
        highlight={justEditedKaution}
        vocab={vocab}
      />

      {/* iOS-Offline-Aufklärung: beide Komponenten gaten sich selbst und sind
          gegenseitig ausschließend — die Warnung nur im iOS-In-App-Browser
          (Outlook/Gmail, dort geht Offline nicht), der Install-Hinweis nur im
          iOS-Safari-Tab (eigener Dismiss-Key, unabhängig vom Startseiten-Hinweis). */}
      <InAppBrowserWarning />
      <InstallHint dismissKey="bordkasse:install-hint-trip" />

      {/* Geräte-Push genau dort anbieten, wo die Crew ist — der Nudge
          versteckt sich selbst, sobald abonniert/nicht unterstützt/weggeklickt. */}
      {hasMembers && <NotificationNudge />}

      <section className="rounded-lg border border-rule bg-paper p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-ink-soft">{vocab.crew}</p>
            <p className="mt-1 text-2xl font-semibold">{memberCount}</p>
          </div>
          <Link
            href={`/trips/${id}/settings`}
            className="text-sm font-medium text-primary hover:underline"
          >
            verwalten →
          </Link>
        </div>
      </section>

      {!hasMembers && (
        <section className="mt-4 rounded-lg border border-dashed border-primary/30 bg-navy-light/30 p-5 text-center">
          <Users className="mx-auto mb-2 h-8 w-8 text-primary" />
          <p className="font-medium text-primary">{vocab.crew} einladen</p>
          <p className="mt-1 text-sm text-ink-soft">
            Bevor du Buchungen erfasst, lege die {vocab.crew} an.
          </p>
          <Link
            href={`/trips/${id}/settings`}
            className="mt-3 inline-flex items-center gap-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-paper hover:bg-navy-dark"
          >
            <Plus className="h-4 w-4" />
            {vocab.crew} hinzufügen
          </Link>
        </section>
      )}

      <section className="mt-6">
        <h2 className="mb-3 font-semibold text-ink">Schnellzugriff</h2>
        <div className="grid grid-cols-2 gap-3">
          <Link
            href={`/trips/${id}/transactions`}
            className="flex flex-col items-start gap-2 rounded-lg border border-rule bg-paper p-4 hover:border-primary/40 hover:bg-navy-light/20"
          >
            <Euro className="h-5 w-5 text-primary" />
            <span className="font-medium">Buchungen</span>
            <span className="text-xs text-ink-soft">Liste aller Ausgaben + Gutschriften</span>
          </Link>
          <Link
            href={`/trips/${id}/balance`}
            className="flex flex-col items-start gap-2 rounded-lg border border-rule bg-paper p-4 hover:border-primary/40 hover:bg-navy-light/20"
          >
            <ScaleIcon className="h-5 w-5 text-primary" />
            <span className="font-medium">Bilanz</span>
            <span className="text-xs text-ink-soft">Wer hat wie viel offen</span>
          </Link>
          {showCreatePrepaymentCta && (
            <Link
              href={`/trips/${id}/prepayments/setup`}
              className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-primary/40 bg-navy-light/20 p-4 hover:border-primary/60 hover:bg-navy-light/30"
            >
              <Coins className="h-5 w-5 text-primary" />
              <span className="font-medium text-primary">Jetzt Anzahlung anlegen</span>
              <span className="text-xs text-ink-soft">{vocab.prepayment} auf die {vocab.crew} aufteilen</span>
            </Link>
          )}
        </div>
      </section>

      {progress && (
        <div className="mt-6">
          <TripProgress
            tripId={id}
            progress={progress}
            canCollapse={!!myMember}
            collapsed={!!myMember?.checklist_collapsed_at}
          />
        </div>
      )}

      {hasMembers && <FabAddTransaction tripId={id} />}
      <OnboardingHint tripId={id} eligible={onboardingEligible} />
    </main>
  );
}
