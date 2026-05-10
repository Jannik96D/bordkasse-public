"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { isEmailAllowedToSignIn } from "@/lib/auth/authz";

const LoginSchema = z.object({
  email: z.string().trim().email("Bitte gültige E-Mail-Adresse eingeben."),
});

export type LoginState =
  | { status: "idle" }
  | { status: "ok"; email: string }
  | { status: "error"; message: string };

export async function signInWithMagicLink(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = LoginSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Ungültige Eingabe.",
    };
  }

  // Nur E-Mails zulassen, die als Admin in ADMIN_EMAILS oder als Crew-
  // Mitglied (persons_private aus inviteMember / createTrip) hinterlegt
  // sind. Verhindert, dass Fremde via Magic-Link-Anforderung auth.users-
  // Rows produzieren, die niemand sieht und nirgendwo zugeordnet sind.
  const allowed = await isEmailAllowedToSignIn(parsed.data.email);
  if (!allowed) {
    return {
      status: "error",
      message:
        "Diese E-Mail-Adresse ist nicht für die Bordkasse hinterlegt. Bitte den Skipper deines Törns, dich einzuladen.",
    };
  }

  const supabase = await createClient();
  const hdrs = await headers();
  const origin = hdrs.get("origin") ?? process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: {
      emailRedirectTo: `${origin}/auth/callback`,
    },
  });

  if (error) {
    return { status: "error", message: error.message };
  }

  return { status: "ok", email: parsed.data.email };
}
