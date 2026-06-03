# Web-Push-Benachrichtigungen — Spec

> Geräte-Push für die Bordkasse-PWA, **zusätzlich** zur E-Mail (nie als Ersatz).

## Grundentscheidung

- **Push und Mail gehen IMMER gemeinsam raus.** Keine Kanal-Präferenz, keine
  Mail-Unterdrückung. Begründung (Skipper-Wunsch): Push wird oft unachtsam
  weggewischt, und die Mail liefert mehr Kontext (Salden, Zahlpläne) als eine
  kurze Mitteilung. Der Push ist der schnelle Weckruf, die Mail der Beleg.
- **Folge:** Push ist an jeder Stelle **rein additiv** — der bestehende
  `sendMail`-Pfad wird nie verändert. `sendPushToPersons` wirft nie (gleicher
  Vertrag wie `sendMail`).
- **iOS:** Web-Push gibt es nur für die **installierte** PWA (Home-Bildschirm),
  ab iOS 16.4. Im Safari-Tab nicht. Der Profil-Block erkennt das und zeigt
  statt eines toten Buttons den Installations-Hinweis.

## Welche Benachrichtigungen pushen (Stand: Erst-Implementierung)

| Event | Push? | Empfänger | Notiz |
|---|---|---|---|
| Abrechnung verschickt (`announceSettlement`) | ✅ | Crew außer Auslöser | Tag `settlement-<trip>` |
| Bilanz-Update (`resendSettlement`) | ✅ | Crew außer Auslöser | gleicher Tag → ersetzt Ankündigung |
| Schuld abgehakt (`toggleDebtSettled`) | ✅ | nur Gegenpartei | Observer (Skipper/Vorstrecker) = **Mail-only** |
| Anzahlungs-Reminder `crew_3d` (Cron) | ✅ | offene Crew | teilt `prepayment_reminder_log` mit der Mail |
| Charter-Reminder `advancer_3d` (Cron) | ✅ | Vorstrecker | |
| Selbstmeldung „ich habe gezahlt" | ✅ | Vorstrecker | actionable |
| Zahlung bestätigt / abgelehnt / erfasst | ✅ | betroffene Crewperson | Actor ausgenommen |
| Notice an Observer (Dritt-Aktion) | ❌ | — | Mail-only |
| Crew-Einladung (Magic-Link) | ❌ | — | technisch unmöglich (noch kein Abo) |
| Manueller Einzel-Reminder (🔔-Button) | ❌ | — | **bewusst Mail-only** (kein Tranche-/Betrag-Kontext am Aufrufpunkt; der Cron deckt den automatischen Pfad ab) |

## Anti-Spam-Regeln (im Code verankert)

1. **Auslöser ≠ Empfänger** — wer die Aktion gerade selbst getippt hat, bekommt
   keinen Push (`pushRecipients(..., { excludeActorId })`). Die Bestätigungs-Mail
   bekommt er weiterhin.
2. **Foreground-Suppression** — der SW unterdrückt die OS-Mitteilung, wenn ein
   sichtbares Fenster **denselben Trip** anzeigt (Realtime-Toast hat es schon
   gezeigt). Ein Push zu einem *anderen* Trip wird NICHT verschluckt.
3. **Collapse per `tag`** — gleicher Tag ersetzt eine vorhandene Mitteilung.
4. **Geteilte Dedup** — `prepayment_reminder_log` / `changes_pending_since` /
   `settlement_announced_at` gelten für beide Kanäle gemeinsam.

## Architektur

- **DB:** Migration `0038_push_subscriptions.sql` — Tabelle `push_subscriptions`
  (`person_id` FK CASCADE, `endpoint` UNIQUE, `p256dh`, `auth`, `user_agent`).
  RLS an, **ohne Policy** → nur Service-Role (wie `prepayment_reminder_log`); der
  Client kennt seinen Abo-Status lokal via `pushManager.getSubscription()`.
- **DSGVO:** `delete_my_account()` löscht `push_subscriptions` **explizit** — die
  `persons`-Row wird beim Self-Delete nur anonymisiert (nicht gelöscht), daher
  feuert `ON DELETE CASCADE` dort nicht. Der `search_path`-Pin aus 0033 wird in
  0038 inline neu gesetzt.
- **Dispatch:** [`lib/notify/web-push.ts`](../webapp/lib/notify/web-push.ts) —
  `sendPushToPersons(supabase, personIds, payload)`. Konfiguriert VAPID lazy,
  sendet `Promise.all` an alle Abos, **löscht Abos bei HTTP 404/410** (tot), wirft
  nie. `server-only`.
- **Payloads:** [`lib/notify/payloads.ts`](../webapp/lib/notify/payloads.ts) —
  reine Funktionen (Vitest-getestet), kurze Texte + `tag` + Ziel-URL.
- **Empfänger:** [`lib/notify/recipients.ts`](../webapp/lib/notify/recipients.ts)
  — `pushRecipients` (dedup + Actor-Exclusion), pure.
- **Service Worker:** [`public/sw.js`](../webapp/public/sw.js) — `push`- +
  `notificationclick`-Listener, Foreground-Suppression, `CACHE_VERSION` →
  `bordkasse-v6`.
- **Client:** [`app/profile/notification-block.tsx`](../webapp/app/profile/notification-block.tsx)
  + [`push-actions.ts`](../webapp/app/profile/push-actions.ts) — opt-in pro Gerät,
  Permission nur auf Klick, `urlBase64ToUint8Array` für `applicationServerKey`.

## Env-Vars (Produktion + lokal)

```
NEXT_PUBLIC_VAPID_PUBLIC_KEY   # Public Key, im Client inlined
VAPID_PRIVATE_KEY              # Private Key, nur Server
VAPID_SUBJECT                  # mailto:… (Pflicht-Feld der VAPID-Spec)
```

Einmalig erzeugen: `npx web-push generate-vapid-keys`. **Stabil halten** — ein
Rotieren entwertet alle bestehenden Geräte-Abos (Versand → HTTP 403).

## Tests

- **Vitest** (`__tests__/notify.test.ts`): Payload-Texte/URLs/Tags,
  `pushRecipients` (Actor-Exclusion/Dedup), `sendPushToPersons` mit gemocktem
  `web-push` (sendet an alle Abos, löscht bei 410, wirft nie, no-op ohne VAPID).
- **Manuell / Geräte-Test (nicht automatisierbar):** Ein echter Push aufs
  physische Gerät braucht einen realen Browser + Push-Dienst — im
  Headless-/CI-Umfeld nicht herstellbar. Checkliste:
  1. PWA auf iPhone (installiert!) + Android installieren.
  2. Profil → „Auf diesem Gerät aktivieren" → Permission erteilen.
  3. Abrechnung verschicken / Schuld abhaken → Mitteilung erscheint auf dem
     gesperrten Gerät, Tap öffnet den richtigen Trip-Tab.
  4. App im Vordergrund auf demselben Trip → keine doppelte Mitteilung.
  5. PWA deinstallieren → nächster Versand putzt das Abo (410) aus der DB.

## Bekannte Grenzen / bewusste Scope-Entscheidungen

- Manueller Einzel-Reminder bleibt Mail-only (s. Tabelle).
- Keine stillen/Data-only-Pushes — jeder Push zeigt eine sichtbare Mitteilung
  (iOS widerruft das Abo sonst).
- Kein zentrales Notification-Center in der App; Push ist flüchtig, die Historie
  steht in den jeweiligen Trip-Tabs + Mails.
