# Auth-Email-Templates

Diese HTML-Templates ersetzen die Default-Mails von Supabase Auth durch ein
Bordkasse-eigenes Design (Logo, Marineblau-Theme, deutsch).

## Einsetzen

1. Supabase-Dashboard → **Authentication → Emails**
2. Template **"Magic Link"** öffnen
3. Subject ersetzen durch: `Dein Bordkasse-Login-Link`
4. Body (HTML) mit dem Inhalt aus [`magic-link.html`](./magic-link.html) überschreiben
5. Speichern → "Send test email" prüfen

Wichtig: Supabase nutzt Go-Templates. Die Variable `{{ .ConfirmationURL }}`
liefert den Magic-Link-Klick-URL — sie ist im HTML bereits zweimal eingebaut
(Button + Fallback-Klartext-Link). Andere verfügbare Variablen:

- `{{ .ConfirmationURL }}` — vollständige Magic-Link-URL
- `{{ .Email }}` — Empfänger-Adresse
- `{{ .Token }}` / `{{ .TokenHash }}` — Token (selten direkt nötig)
- `{{ .SiteURL }}` — Site-URL aus Supabase-Auth-Config

## Bilder

Das Logo wird absolut aus `https://bordkasse.dieter.ms/logo.png` geladen.
Wenn die Domain wechselt, hier die URL anpassen.

## Andere Templates

Für Bordkasse v0.1 ist nur Magic-Link aktiv. Die anderen Templates
(Confirm Signup, Invite, Recovery, Email Change) werden aktuell nicht
verschickt — können bei Bedarf nach demselben Schema gestaltet werden.
