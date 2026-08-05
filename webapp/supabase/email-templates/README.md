# Auth-Email-Templates

Diese HTML-Templates ersetzen die Default-Mails von Supabase Auth durch ein
Bordkasse-eigenes Design (Logo, Marineblau-Theme, deutsch).

## Wo das Template liegt

➡️ **[`webapp/public/email/magic-link.html`](../../public/email/magic-link.html)**

Seit dem Umzug auf den selbst gehosteten Supabase-Stack ist das die
**einzige** Quelle. Früher lag hier ein zweiter Snapshot, der von Hand ins
Supabase-Dashboard kopiert wurde — dieses Dashboard gibt es nicht mehr, und
zwei Kopien wären auseinandergedriftet.

## Einsetzen

Nichts zu tun — das Template wird automatisch wirksam:

1. Die App liefert die Datei unter `/email/magic-link.html` aus (öffentlich
   erreichbar über eine Ausnahme im `config.matcher` von `proxy.ts`).
2. Der `auth`-Container holt sie per HTTP über
   `GOTRUE_MAILER_TEMPLATES_MAGIC_LINK` (siehe
   `supabase/self-host/.env.example`).

Selbst gehostetes GoTrue liest Templates **ausschließlich per URL**, nicht
aus gemounteten Dateien — daher der Weg über `public/`.

⚠️ **Ist die URL nicht erreichbar, fällt GoTrue still auf sein
Default-Template zurück** — die Mail kommt an, nur unbrandet, und im Log
steht kein Fehler. Nach jeder Änderung an Datei, Domain oder Matcher also
eine echte Testmail auslösen und anschauen.

Wichtig: Supabase nutzt Go-Templates. Wir bauen die Login-URL bewusst
selbst über `{{ .TokenHash }}` statt `{{ .ConfirmationURL }}` zu nutzen.

Hintergrund: `{{ .ConfirmationURL }}` zeigt auf Supabase's PKCE-Endpoint
(`/auth/v1/verify?...`), der den User zu unserem `/auth/callback?code=…`
weiterleitet. Dort braucht es einen Code-Verifier aus dem Browser-Cookie
des Users — den hat aber NUR der Browser, in dem der Magic-Link
angefordert wurde. Klickt der User in einem anderen Browser (z.B.
iOS-Mail-Webview vs. Safari, Outlook-App vs. Chrome), bricht der Flow mit
„PKCE code verifier not found in storage".

Mit dem Token-Hash-Flow umgehen wir das: der Link zeigt direkt auf unsere
`/auth/confirm`-Route, die `verifyOtp({ token_hash, type })` aufruft —
keine Verifier-Cookies nötig, der Token wird serverseitig gegen die
Supabase-Auth-DB geprüft.

**Wichtig: `type=email` wird hartkodiert**, nicht über `{{ .Type }}` —
Supabase rendert `{{ .Type }}` für Magic-Links oft als leeren String,
was unsere `verifyOtp({ token_hash, type })`-Validierung mit
`missing_token` abbrechen lässt. `type=email` ist die offizielle
Empfehlung der Supabase Next.js-SSR-Docs.

Verfügbare Variablen:

- `{{ .TokenHash }}` — Hash für `verifyOtp` (von uns genutzt)
- `{{ .SiteURL }}` — Site-URL aus Supabase-Auth-Config (von uns genutzt)
- `{{ .Email }}` — Empfänger-Adresse
- `{{ .Token }}` — 6-stelliger OTP-Code
- `{{ .Type }}` — bei Magic-Links oft leer, daher nicht verwendet
- `{{ .ConfirmationURL }}` — PKCE-URL (NICHT verwenden, siehe oben)

## Bilder

Das Logo wird absolut aus `https://bordkasse.dieter.ms/logo.png` geladen.
Wenn die Domain wechselt, hier die URL anpassen.

## Andere Templates

Für Bordkasse v0.1 ist nur Magic-Link aktiv. Die anderen Templates
(Confirm Signup, Invite, Recovery, Email Change) werden aktuell nicht
verschickt — können bei Bedarf nach demselben Schema gestaltet werden.
