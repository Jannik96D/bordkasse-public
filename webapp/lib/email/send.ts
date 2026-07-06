/**
 * Schickt transaktionale Mails über den konfigurierten SMTP-Server.
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
 * Einzelversand (`sendMail`) öffnet einen Transport pro Aufruf — stabil und
 * einfach. Für BATCHES an eine ganze Crew (Abrechnung, Schuld-Benachrichtigung)
 * gibt es `sendMails`: EIN gepoolter Transport mit begrenzten, wieder-
 * verwendeten Verbindungen, der alle Mails NEBENLÄUFIG verschickt statt N
 * sequenzieller TCP+TLS+AUTH-Handshakes (bei 12 Crew: ~Sekunden statt viele
 * Sekunden Block). Der Pool wird pro Aufruf erstellt und wieder geschlossen →
 * serverless-sicher (kein modul-globaler, hängender Transport).
 */

import nodemailer from "nodemailer";

export type SendResult = { ok: true; id: string } | { ok: false; error: string };
export type MailMessage = { to: string; subject: string; html: string; text?: string; replyTo?: string };

const FROM_DEFAULT = process.env.MAIL_FROM ?? "Bordkasse <bordkasse@example.com>";
const NOT_CONFIGURED = "Mail-Versand nicht konfiguriert (SMTP_HOST/PORT/USER/PASS fehlen).";

/** SMTP-Grundkonfiguration aus den Env-Vars; null, wenn unvollständig. */
function smtpConfig(): { host: string; port: number; secure: boolean; auth: { user: string; pass: string } } | null {
  const host = process.env.SMTP_HOST;
  const portRaw = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !portRaw || !user || !pass) return null;
  const port = Number(portRaw);
  // Port 465 = implizites SSL, 587 = STARTTLS, alles andere → kein SSL.
  return { host, port, secure: port === 465, auth: { user, pass } };
}

function toSendResult(err: unknown): SendResult {
  console.error("[bordkasse:mail]", err);
  const message = err instanceof Error ? err.message : "unbekannter Fehler";
  return { ok: false, error: `Mail-Versand fehlgeschlagen: ${message}` };
}

export async function sendMail({
  to,
  subject,
  html,
  text,
  replyTo,
}: MailMessage): Promise<SendResult> {
  const cfg = smtpConfig();
  if (!cfg) return { ok: false, error: NOT_CONFIGURED };

  const transporter = nodemailer.createTransport(cfg);
  try {
    const info = await transporter.sendMail({ from: FROM_DEFAULT, to, subject, html, text, replyTo });
    return { ok: true, id: info.messageId };
  } catch (err) {
    return toSendResult(err);
  } finally {
    transporter.close();
  }
}

/**
 * Versendet mehrere Mails über EINEN gepoolten Transport, nebenläufig
 * (bounded via maxConnections). Ergebnis-Array in EINGABE-Reihenfolge — der
 * Aufrufer aggregiert sent/failed selbst. Wirft nie (jede Mail liefert ihr
 * eigenes SendResult). Leere Liste → leeres Array.
 */
export async function sendMails(messages: MailMessage[]): Promise<SendResult[]> {
  if (messages.length === 0) return [];
  const cfg = smtpConfig();
  if (!cfg) return messages.map(() => ({ ok: false, error: NOT_CONFIGURED }));

  const transporter = nodemailer.createTransport({
    ...cfg,
    pool: true,
    maxConnections: 5, // schont den Mailserver (keine 12 gleichzeitigen Verbindungen)
    maxMessages: 100,
  });
  try {
    return await Promise.all(
      messages.map(async (m): Promise<SendResult> => {
        try {
          const info = await transporter.sendMail({ from: FROM_DEFAULT, ...m });
          return { ok: true, id: info.messageId };
        } catch (err) {
          return toSendResult(err);
        }
      }),
    );
  } finally {
    transporter.close();
  }
}
