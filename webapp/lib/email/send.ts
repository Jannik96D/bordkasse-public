/**
 * Schickt eine transaktionale Mail über den konfigurierten SMTP-Server.
 *
 * Nutzt nodemailer + denselben SMTP, der bereits für Supabase-Auth-Mails
 * angebunden ist (Magic-Link). Credentials kommen aus Vercel-Env-Vars,
 * NICHT aus Supabase — die App spricht den Mailserver direkt an.
 *
 * Pflicht-Env-Vars:
 *   SMTP_HOST       z. B. mail.example.com
 *   SMTP_PORT       587 (STARTTLS) oder 465 (SSL)
 *   SMTP_USER       z. B. bordkasse@dieter.ms
 *   SMTP_PASS       Passwort / App-Token
 *   MAIL_FROM       z. B. "Bordkasse <bordkasse@dieter.ms>"
 *
 * Connection-Pooling lohnt nicht — wir versenden punktuell ein paar Mails
 * pro Settlement, nicht im Sekundentakt. Ein neuer Transport pro Aufruf
 * ist stabil und einfacher zu reasonen.
 */

import nodemailer from "nodemailer";

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
  const host = process.env.SMTP_HOST;
  const portRaw = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !portRaw || !user || !pass) {
    return {
      ok: false,
      error: "Mail-Versand nicht konfiguriert (SMTP_HOST/PORT/USER/PASS fehlen).",
    };
  }
  const port = Number(portRaw);
  // Port 465 = implizites SSL, 587 = STARTTLS, alles andere → kein SSL.
  const secure = port === 465;

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  try {
    const info = await transporter.sendMail({
      from: FROM_DEFAULT,
      to,
      subject,
      html,
      text,
      replyTo,
    });
    return { ok: true, id: info.messageId };
  } catch (err) {
    console.error("[bordkasse:mail]", err);
    const message = err instanceof Error ? err.message : "unbekannter Fehler";
    return { ok: false, error: `Mail-Versand fehlgeschlagen: ${message}` };
  }
}
