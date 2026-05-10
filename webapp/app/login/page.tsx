"use client";

import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useActionState, useEffect, useState } from "react";
import { signInWithMagicLink, type LoginState } from "./actions";
import { AlertCircle, Mail } from "lucide-react";

const initial: LoginState = { status: "idle" };
const RESEND_DELAY_MS = 30_000;

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
  // PKCE-Verifier fehlt, Code abgelaufen). /auth/callback hängt diese Infos
  // als Query-Parameter an, damit hier ohne Logs erkennbar ist, was
  // schief lief.
  const params = useSearchParams();
  const authError = params.get("auth_error");
  const authErrorMsg = params.get("auth_error_msg");

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
              <div className="space-y-1 text-sm">
                <p className="font-medium text-danger">
                  Login fehlgeschlagen
                </p>
                <p className="text-ink-soft">
                  {authErrorMsg ?? "Bitte fordere einen neuen Magic-Link an."}
                </p>
                <p className="text-xs text-ink-soft">
                  Code: <code className="font-mono">{authError}</code>
                </p>
              </div>
            </div>
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
