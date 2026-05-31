import Image from "next/image";
import Link from "next/link";
import { safeNextPath } from "@/lib/auth/origin";

export const dynamic = "force-dynamic";

/**
 * Klick-Bestätigungsseite für Magic-Link-Mails.
 *
 * Warum keine direkte Verifizierung im GET? Manche Mail-Programme (Outlook
 * Safe Links, Gmail Spam-Filter, einige Antivirus-Tools) rufen URLs in
 * eingehenden Mails automatisch im Hintergrund auf, um die Reputation zu
 * prüfen. Diese „Scans" sind echte HTTP-GET-Requests und würden einen
 * direkt verifizierenden Endpunkt den Single-Use-Token verbrauchen lassen,
 * bevor der menschliche User überhaupt klickt — Resultat: `otp_expired`
 * beim echten Klick.
 *
 * Lösung: GET liefert nur diese Bestätigungs-UI. Erst der Button-Klick
 * (POST nach /auth/verify) verbraucht den Token. Link-Scanner crawlen
 * praktisch nie POST-Forms, der Token bleibt also für den echten User
 * erhalten.
 */
export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token_hash?: string; type?: string; next?: string; email?: string }>;
}) {
  const params = await searchParams;
  const token_hash = params.token_hash;
  const type = params.type;
  const next = safeNextPath(params.next);
  // Empfänger-E-Mail aus dem Magic-Link-Template (`{{ .Email }}`). Wird
  // benötigt, falls verifyOtp mit otp_expired antwortet — dann zeigt die
  // /login-Page einen Auto-Resend-Button für diese Adresse, ohne dass der
  // User sie erneut eintippen muss.
  const email = params.email;

  // Fehlt der Token, kommt der User über einen kaputten Link — direkt zur
  // Login-Seite mit Hinweis.
  if (!token_hash || !type) {
    const errorTarget = new URL("/login", "http://example.invalid");
    errorTarget.searchParams.set("auth_error", "missing_token");
    errorTarget.searchParams.set(
      "auth_error_msg",
      "Der Login-Link enthält keinen gültigen Token. Fordere einen neuen an.",
    );
    return (
      <main className="flex flex-1 flex-col items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm space-y-4 text-center">
          <p className="text-danger">Login-Link ungültig.</p>
          <Link
            href={`/login${errorTarget.search}`}
            className="inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-paper"
          >
            Zur Anmeldung
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm space-y-6 text-center">
        <Image
          src="/logo.png"
          alt="Bordkasse"
          width={120}
          height={92}
          priority
          className="mx-auto h-auto w-28"
        />
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-primary">Login bestätigen</h1>
          <p className="text-sm text-ink-soft">
            Klick auf den Button, um dich bei der Bordkasse einzuloggen.
          </p>
        </div>

        <form action="/auth/verify" method="POST" className="space-y-3">
          <input type="hidden" name="token_hash" value={token_hash} />
          <input type="hidden" name="type" value={type} />
          <input type="hidden" name="next" value={next} />
          {email && <input type="hidden" name="email" value={email} />}
          <button
            type="submit"
            className="w-full rounded-md bg-primary px-4 py-3 font-medium text-paper hover:bg-navy-dark"
          >
            Jetzt einloggen
          </button>
        </form>
      </div>
    </main>
  );
}
