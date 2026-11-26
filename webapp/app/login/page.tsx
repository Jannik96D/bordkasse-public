import { cookies } from "next/headers";
import { displayableEmail } from "@/lib/auth/email-param";
import { loginIntentCookieName, loginIntentMatches } from "@/lib/auth/login-intent";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

/**
 * Server-Wrapper: entscheidet, ob die Adresse aus `?email=` in Formular und
 * „Neuen Link senden“-Knopf übernommen werden darf. Nur wenn das Login-Intent-
 * Cookie dieses Browsers (HttpOnly, daher nur serverseitig lesbar) zu genau
 * dieser Adresse passt — d. h. der Nutzer hat sie selbst hier angefordert
 * (Resend nach abgelaufenem Link). Sonst leeres Formular: Adresse selbst tippen.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string | string[] }>;
}) {
  const raw = (await searchParams).email;
  const email = Array.isArray(raw) ? raw[0] : raw;
  const cookieStore = await cookies();
  const trusted =
    !!email && loginIntentMatches(email, cookieStore.get(loginIntentCookieName())?.value);
  return <LoginForm prefillEmail={(trusted && displayableEmail(email)) || ""} />;
}
