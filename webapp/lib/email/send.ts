/**
 * Schickt eine transaktionale Mail über die Resend-HTTP-API.
 *
 * Resend wird direkt via fetch angesprochen — kein npm-SDK, damit das Bundle
 * schlank bleibt und keine zusätzliche Abhängigkeit gepflegt werden muss.
 * Voraussetzung: `RESEND_API_KEY` in den Vercel-Env-Vars + verifizierte
 * Sender-Domain. Ist der Key nicht gesetzt, schlägt der Versand mit einer
 * klaren deutschen Meldung fehl — ohne dass die Server-Action crasht.
 *
 * Doku: https://resend.com/docs/api-reference/emails/send-email
 */

export type SendResult = { ok: true; id: string } | { ok: false; error: string };

const FROM_DEFAULT = process.env.MAIL_FROM ?? "Bordkasse <bordkasse@example.com>";

export async function sendMail({
  to,
  subject,
  html,
  text,
  replyTo,
}: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error: "Mail-Versand nicht konfiguriert (RESEND_API_KEY fehlt).",
    };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_DEFAULT,
        to: [to],
        subject,
        html,
        text,
        reply_to: replyTo,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error("[bordkasse:mail]", res.status, body);
      return { ok: false, error: `Mail-Versand fehlgeschlagen (HTTP ${res.status}).` };
    }
    const data = (await res.json()) as { id?: string };
    return { ok: true, id: data.id ?? "" };
  } catch (err) {
    console.error("[bordkasse:mail] fetch error", err);
    return { ok: false, error: "Mail-Versand fehlgeschlagen (Netzwerk-Fehler)." };
  }
}
