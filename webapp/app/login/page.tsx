"use client";

import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useActionState, useEffect, useState } from "react";
import { signInWithMagicLink, type LoginState } from "./actions";
import { AlertCircle, Mail } from "lucide-react";

const initial: LoginState = { status: "idle" };
const RESEND_DELAY_MS = 30_000;

/**
 * Übersetzt Supabase/PostgREST-Auth-Codes in deutsche User-Texte.
 * Fallback: generische Meldung, falls Code unbekannt — die englische
 * Original-Message würde sonst durchsickern.
 */
function translateAuthError(code: string, _rawMessage: string | null): string {
  void _rawMessage; // Im Server-Log unter [bordkasse:auth] verfügbar.
  switch (code) {
    case "otp_expired":
      return "Der Magic-Link ist abgelaufen. Fordere bitte einen neuen an.";
    case "verify_failed":
      return "Magic-Link konnte nicht verifiziert werden. Eventuell wurde er schon benutzt.";
    case "exchange_failed":
      return "Login-Token konnte nicht eingelöst werden. Bitte erneut versuchen.";
    case "missing_token":
      return "Im Link fehlt der Token. Bitte fordere einen frischen Magic-Link an.";
    case "access_denied":
      return "Zugriff verweigert. Falls dein Account neu ist, frage den Skipper, dich zur Crew einzuladen.";
    case "user_not_allowed":
      return "Diese E-Mail-Adresse ist nicht eingeladen. Bitte beim Skipper melden.";
    default:
      return "Bitte fordere einen neuen Magic-Link an.";
  }
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageInner() {
  const [state, formAction, pending] = useActionState(signInWithMagicLink, initial);
  // Snapshot: für welche ok-Mail ist der 30-s-Timer schon durch?
  // Wechselt die Mail (Resend, andere Adresse), passt der Snapshot nicht
  // mehr und showResend ist wieder false — ohne synchrones setState im Effect.
  const [resendReadyFor, setResendReadyFor] = useState<string | null>(null);
  const okEmail = state.status === "ok" ? state.email : null;
  const showResend = state.status === "ok" && resendReadyFor === okEmail;

  // Auth-Fehler aus dem Callback (z.B. exchangeCodeForSession failed,
  // PKCE-Verifier fehlt, Code abgelaufen). /auth/callback und /auth/verify
  // hängen die Infos als Query-Parameter an, damit hier ohne Logs erkennbar
  // ist, was schief lief.
  //
  // Bonus: bei otp_expired etc. hängt /auth/verify auch die Empfänger-
  // E-Mail dran — damit kann der User mit einem Klick eine frische Mail
  // anfordern, ohne seine Adresse erneut zu tippen.
  const params = useSearchParams();
  const authError = params.get("auth_error");
  const authErrorMsg = params.get("auth_error_msg");
  const authErrorEmail = params.get("email") ?? "";

  useEffect(() => {
    if (!okEmail) return;
    const timer = setTimeout(() => setResendReadyFor(okEmail), RESEND_DELAY_MS);
    return () => clearTimeout(timer);
  }, [okEmail]);

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <Image
            src="/logo.png"
            alt="Bordkasse"
            width={160}
            height={123}
            priority
            className="mx-auto mb-3 h-auto w-40"
          />
          <h1 className="text-3xl font-bold text-primary">Bordkasse</h1>
          <p className="mt-2 text-sm text-ink-soft">
            Anmeldung per Magic-Link — du bekommst eine E-Mail mit einem
            Login-Link.
          </p>
        </div>

        {authError && (
          <div
            className="rounded-lg border border-danger/30 bg-danger/5 p-4"
            role="alert"
          >
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-danger" />
              <div className="flex-1 space-y-1 text-sm">
                <p className="font-medium text-danger">
                  Login fehlgeschlagen
                </p>
                <p className="text-ink-soft">
                  {translateAuthError(authError, authErrorMsg)}
                </p>
                <p className="text-xs text-ink-soft">
                  Code: <code className="font-mono">{authError}</code>
                </p>
              </div>
            </div>

            {authErrorEmail && state.status !== "ok" && (
              <form action={formAction} className="mt-3 border-t border-danger/20 pt-3">
                <input type="hidden" name="email" value={authErrorEmail} />
                <button
                  type="submit"
                  disabled={pending}
                  className="w-full rounded-md bg-primary px-4 py-3 text-sm font-medium text-paper hover:bg-navy-dark disabled:opacity-60"
                >
                  {pending ? "Sende neuen Link …" : `Neuen Link an ${authErrorEmail} senden`}
                </button>
              </form>
            )}
          </div>
        )}

        {state.status === "ok" ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-success/30 bg-success/5 p-5 text-center">
              <Mail className="mx-auto mb-2 h-8 w-8 text-success" />
              <p className="font-medium text-success">Mail unterwegs</p>
              <p className="mt-2 text-sm text-ink-soft">
                Wir haben einen Login-Link an{" "}
                <span className="font-medium text-ink">{state.email}</span>{" "}
                geschickt. Klick den Link in der Mail, um eingeloggt zu werden.
              </p>
              <p className="mt-3 text-xs text-ink-soft">
                Tipp: Schau auch im Spam-/Werbung-Ordner.
              </p>
            </div>

            {showResend && (
              <form action={formAction} className="rounded-lg border border-rule bg-paper-soft p-4 text-center">
                <p className="text-sm text-ink-soft">Mail nicht angekommen?</p>
                <input type="hidden" name="email" value={state.email} />
                <button
                  type="submit"
                  disabled={pending}
                  className="mt-2 w-full rounded-md border border-primary px-4 py-3 text-sm font-medium text-primary hover:bg-primary hover:text-paper disabled:opacity-60"
                >
                  {pending ? "Sende erneut …" : "Mail erneut senden"}
                </button>
              </form>
            )}
          </div>
        ) : (
          <form action={formAction} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="email" className="block text-sm font-medium">
                E-Mail-Adresse
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                defaultValue={authErrorEmail}
                placeholder="du@example.com"
                className="w-full rounded-md border border-rule bg-paper px-4 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </div>

            {state.status === "error" && (
              <p className="text-sm text-danger" role="alert">
                {state.message}
              </p>
            )}

            <button
              type="submit"
              disabled={pending}
              className="w-full rounded-md bg-primary px-4 font-medium text-paper transition-colors hover:bg-navy-dark disabled:opacity-60"
            >
              {pending ? "Sende Mail …" : "Magic-Link anfordern"}
            </button>
          </form>
        )}

        {process.env.NODE_ENV === "development" && (
          <p className="text-center text-xs text-ink-soft">
            Lokal: Mails landen im{" "}
            <a
              href="http://127.0.0.1:54324"
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-primary"
            >
              Mailpit
            </a>
            .
          </p>
        )}

        <p className="text-center text-xs text-ink-soft">
          <Link href="/datenschutz" className="hover:text-primary">Datenschutz</Link>
        </p>
      </div>
    </main>
  );
}
