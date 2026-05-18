import Link from "next/link";

export const metadata = {
  title: "Datenschutz · Bordkasse",
};

export default function DatenschutzPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10">
      <div className="mb-6">
        <Link href="/" className="text-sm text-ink-soft hover:text-primary">
          ← Übersicht
        </Link>
      </div>

      <h1 className="text-2xl font-bold text-primary">Datenschutzerklärung</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Hinweise zum Umgang mit personenbezogenen Daten gemäß DSGVO
      </p>

      <section className="prose mt-8 max-w-none space-y-6 text-sm leading-relaxed">
        <div>
          <h2 className="text-base font-semibold">1. Verantwortlich</h2>
          <p>
            Jannik Dieter — Kontakt unter{" "}
            <a href="mailto:bordkasse@dieter.ms" className="underline">
              bordkasse@dieter.ms
            </a>
            . Diese Anwendung wird als private, nicht-kommerzielle Crew-App
            betrieben.
          </p>
        </div>

        <div>
          <h2 className="text-base font-semibold">2. Welche Daten werden verarbeitet?</h2>
          <ul className="ml-5 list-disc">
            <li>
              <strong>E-Mail-Adresse</strong> — für Login per Magic-Link und Crew-Einladungen.
              Nur sichtbar für dich selbst und den Skipper deiner Crews.
            </li>
            <li>
              <strong>Anzeigename</strong> (in der Regel Vorname) — wie du auf
              Buchungen, in der Bilanz und in der Crew-Liste erscheinst.
            </li>
            <li>
              <strong>Nachname (optional)</strong> — wird nur intern (Self + Skipper)
              angezeigt, nicht in fremden Trips. Hilfreich, wenn mehrere Crew-Mitglieder
              den gleichen Vornamen haben.
            </li>
            <li>
              <strong>Optionales Profil-Flag</strong> „Alkohol-Trinker während des Törns“ —
              beeinflusst, wer den Alkohol-Anteil bei Ausgaben mitträgt.
            </li>
            <li>
              <strong>Trip-Daten</strong> — Crew, Anwesenheits-Tage, Buchungen, Beträge,
              Aufteilungen — geteilt nur mit den Crew-Mitgliedern dieses Trips.
            </li>
            <li>
              <strong>Sichtbarkeits-Marker für Alt-Statistik</strong> — nach DSGVO-Löschung
              eines abgeschlossenen Törns (siehe §5) wird ausschließlich ein Verweis
              „Person X war Mitglied von Trip Y“ aufbewahrt, damit du deine anonymisierten
              Aggregate in der Gesamt-Statistik (<em>/stats</em>) weiter sehen kannst. Keine
              weiteren personenbezogenen Inhalte.
            </li>
            <li>
              <strong>Server-Logs</strong> — IP-Adresse, Zeitstempel, User-Agent,
              kurzfristig gespeichert zur Fehlersuche und Missbrauchsabwehr.
            </li>
          </ul>
        </div>

        <div>
          <h2 className="text-base font-semibold">3. Rechtsgrundlage</h2>
          <p>
            Die Verarbeitung erfolgt auf Grundlage deiner Einwilligung (Art. 6 Abs. 1 lit. a
            DSGVO) durch deine Anmeldung sowie zur Vertragserfüllung der bereitgestellten
            Funktionen (Art. 6 Abs. 1 lit. b DSGVO).
          </p>
        </div>

        <div>
          <h2 className="text-base font-semibold">4. Auftragsverarbeiter</h2>
          <p>Folgende Dienstleister verarbeiten Daten in unserem Auftrag:</p>
          <ul className="ml-5 list-disc">
            <li>
              <strong>Supabase</strong> (Datenbank, Auth) —
              Supabase Inc., 970 Toa Payoh North #07-04, Singapur 318992. Server-Standort:
              Frankfurt (EU). Datenschutzerklärung:{" "}
              <a
                href="https://supabase.com/privacy"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                supabase.com/privacy
              </a>
            </li>
            <li>
              <strong>Vercel</strong> (Hosting) — Vercel Inc., 340 S Lemon Ave #4133, Walnut, CA
              91789, USA. Server-Funktionen und Cron-Jobs laufen in der EU-Region{" "}
              <code>fra1</code> (Frankfurt), konfiguriert in <code>vercel.json</code>. Statische
              Assets (HTML/CSS/JS) liefert das globale Vercel-CDN aus — diese enthalten keine
              personenbezogenen Daten. Datenschutzerklärung:{" "}
              <a
                href="https://vercel.com/legal/privacy-policy"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                vercel.com/legal/privacy-policy
              </a>
            </li>
            <li>
              <strong>E-Mail-Versand</strong> — Eigener Mailserver bei whost.dev (Deutschland)
              für Login- und Einladungs-Mails.
            </li>
          </ul>
        </div>

        <div>
          <h2 className="text-base font-semibold">5. Speicherdauer</h2>
          <p>
            <strong>Profilinformationen</strong> (Anzeigename, optionaler Nachname,
            E-Mail-Adresse, Alkohol-Flag) bleiben gespeichert, solange dein Konto existiert.
            Du kannst dein Konto jederzeit selbst löschen — siehe §8 „Konto selbst löschen“.
          </p>
          <p className="mt-2">
            <strong>Trip-bezogene Daten werden 30 Tage nach Törn-Ende automatisch gelöscht,</strong>{" "}
            sobald zusätzlich der Skipper die Abrechnung verschickt und alle Zahlungen in der
            App als erledigt markiert sind. Konkret betrifft das:
          </p>
          <ul className="ml-5 mt-2 list-disc">
            <li>Crew-Liste (wer war wann an Bord, Alkohol-Flag, Notizen)</li>
            <li>Buchungen mit Personen-Bezug (wer hat bezahlt, wer ist beteiligt)</li>
            <li>Gutschriften und „Bezahlt“-Markierungen</li>
            <li>Audit-Log-Einträge dieses Törns</li>
            <li>Ghost-Personen, die nirgends mehr Mitglied sind</li>
          </ul>
          <p className="mt-2">
            Solange noch offene Schulden in der App stehen, bleiben die Daten bewusst
            erhalten — sonst gingen die laufenden Zahlungen verloren.
          </p>
          <p className="mt-2">
            Skipper und Admins können die Löschung über die Trip-Einstellungen auch
            <em> früher</em> anstoßen, sobald alle Zahlungen erledigt sind — die 30-Tage-Frist
            ist eine Obergrenze, kein Mindestwert.
          </p>
          <p className="mt-2">
            <strong>Was bleibt:</strong> zwei separate Bestandteile, die zusammen
            die anonyme Statistik möglich machen, ohne dass Inhalte deiner Buchungen
            erhalten bleiben:
          </p>
          <ul className="ml-5 mt-2 list-disc">
            <li>
              <strong>Anonymes Aggregat</strong> (Datum, Kategoriename, Tagessumme,
              Alkohol-Anteil) — wie bisher, ohne jeden Personenbezug. Erlaubt dir
              im Statistik-Tab auch Jahre später noch zu sehen, wie viel insgesamt
              z. B. für „Sprit“ oder „Restaurant“ ausgegeben wurde, ohne dass
              erkennbar ist, wer beteiligt war oder wer gezahlt hat.
            </li>
            <li>
              <strong>Sichtbarkeits-Marker</strong> (nur Person-ID + Trip-ID,
              kein Inhalt) — wird nur für angemeldete Crew-Mitglieder mit Login
              angelegt (nicht für eingeladene Ghost-Personen). Zweck: damit dir
              in deiner persönlichen Gesamt-Statistik unter <em>/stats</em> auch
              deine alten, anonymisierten Törn-Aggregate weiterhin angezeigt werden
              können. Ohne diesen Marker wärst du nach 30 Tagen für die App nicht
              mehr als ehemaliges Crew-Mitglied erkennbar und sähest deine eigenen
              früheren Törns in der Übersicht nicht mehr.
            </li>
          </ul>
          <p className="mt-2">
            Wenn du dein Konto vollständig löschst (Selbst-Service im{" "}
            <a href="/profile" className="underline">Profil</a>, siehe „Deine Rechte“),
            werden auch deine Sichtbarkeits-Marker mit gelöscht. Die anonymen
            Aggregate bleiben dann ohne deinen Personenbezug erhalten — andere
            ehemalige Crew-Mitglieder können sie weiterhin sehen, du selbst nicht mehr.
          </p>
          <p className="mt-2">
            Auf Wunsch löschen wir deine Daten auch vor Ablauf der 30 Tage unverzüglich
            (siehe „Deine Rechte“). Server-Logs werden nach maximal 30 Tagen gelöscht.
          </p>
        </div>

        <div>
          <h2 className="text-base font-semibold">6. Cookies</h2>
          <p>
            Wir setzen ausschließlich technisch notwendige Cookies für die Login-Session
            (Supabase Auth-Cookie). Es werden keine Tracking-, Analyse- oder Werbe-Cookies
            verwendet.
          </p>
        </div>

        <div>
          <h2 className="text-base font-semibold">
            7. Offline-Nutzung & lokaler Cache
          </h2>
          <p>
            Die Bordkasse funktioniert als Progressive Web App (PWA) auch ohne
            Internet-Verbindung. Dein Browser speichert dafür zwei Arten von Daten
            lokal auf deinem Endgerät:
          </p>
          <ul className="ml-5 mt-2 list-disc">
            <li>
              <strong>Seiten-Cache</strong> — bereits besuchte Crew-Liste, Buchungen,
              Bilanz etc. werden gespeichert, damit du sie offline ansehen kannst.
            </li>
            <li>
              <strong>Offline-Outbox</strong> — Buchungen, die du offline erfasst, werden
              vorübergehend in einer IndexedDB-Warteschlange auf deinem Endgerät
              abgelegt und automatisch zum Server synchronisiert, sobald du wieder
              online bist. Danach werden sie aus dem lokalen Speicher entfernt.
            </li>
          </ul>
          <p className="mt-2">
            <strong>Konsequenz für die Datenlöschung:</strong> Werden Daten serverseitig
            gelöscht (Cron oder manueller Trigger), bleibt der zuletzt im Browser gesehene
            Stand auf dem Endgerät weiter sichtbar, bis du das nächste Mal{" "}
            <em>online</em> eine Seite öffnest — dann zieht die App automatisch den
            aktuellen Stand vom Server (NetworkFirst-Strategie).
          </p>
          <p className="mt-2">
            Wenn du den lokalen Cache sofort leeren möchtest:
          </p>
          <ul className="ml-5 mt-1 list-disc">
            <li>
              <strong>iOS Safari</strong>: Einstellungen → Safari → Erweitert → Website-
              Daten → bordkasse.dieter.ms entfernen
            </li>
            <li>
              <strong>Android Chrome</strong>: App-Info → Speicher → Daten löschen
            </li>
            <li>
              <strong>Desktop</strong>: DevTools (F12) → Application → Storage → „Clear
              site data“
            </li>
          </ul>
          <p className="mt-2 text-xs text-ink-soft">
            Hinweis: lokal gespeicherte Daten sind nur für dich auf deinem Endgerät
            sichtbar — andere Crew-Mitglieder sehen ausschließlich, was der Server liefert.
          </p>
        </div>

        <div>
          <h2 className="text-base font-semibold">8. Deine Rechte</h2>
          <p>Du hast jederzeit das Recht auf:</p>
          <ul className="ml-5 list-disc">
            <li>Auskunft über deine gespeicherten Daten (Art. 15 DSGVO)</li>
            <li>Berichtigung unrichtiger Daten (Art. 16 DSGVO)</li>
            <li>Löschung deiner Daten (Art. 17 DSGVO)</li>
            <li>Einschränkung der Verarbeitung (Art. 18 DSGVO)</li>
            <li>Datenübertragbarkeit (Art. 20 DSGVO)</li>
            <li>Widerspruch gegen die Verarbeitung (Art. 21 DSGVO)</li>
            <li>
              Beschwerde bei der zuständigen Aufsichtsbehörde (z. B. dem
              Landesdatenschutzbeauftragten deines Bundeslandes)
            </li>
          </ul>
          <p className="mt-2">
            <strong>Konto selbst löschen:</strong> Du kannst dein Konto jederzeit
            direkt in der App löschen — im{" "}
            <a href="/profile" className="underline">Profil</a> findest du den
            Block „Konto löschen“. Die Löschung greift sofort: E-Mail, Nachname
            und Login werden entfernt; in Törns, in denen du Buchungen erfasst hast,
            bleibt dein Vorname als „Ehemaliges Crew-Mitglied“ stehen, damit die
            Bilanz nicht zerbricht. Während eines aktiven Törns (Törn-Ende in der
            Zukunft) ist die Löschung blockiert, wenn du dort Buchungen hast —
            sonst gingen offene Schulden verloren.
          </p>
          <p className="mt-2">
            Für alles, was nicht über den Selbst-Service abgedeckt ist
            (Auskunft, Datenexport, vollständige Trip-Löschung als Skipper o. Ä.),
            wende dich formlos an{" "}
            <a href="mailto:bordkasse@dieter.ms" className="underline">
              bordkasse@dieter.ms
            </a>
            .
          </p>
        </div>

        <div>
          <h2 className="text-base font-semibold">9. Datensicherheit</h2>
          <p>
            Die Übertragung erfolgt verschlüsselt via HTTPS/TLS. Datenbank-Zugriffe sind
            durch Row-Level-Security so eingeschränkt, dass jedes Crew-Mitglied nur Daten
            seiner eigenen Trips sehen kann. Login-Mails werden nur an bereits eingeladene
            E-Mail-Adressen oder Admins ausgeliefert (Whitelist-Schutz).
          </p>
          <p className="mt-2">
            <strong>App-Admin-Zugriff:</strong> Der Betreiber dieser App (siehe §1) hat
            für Wartungs- und Support-Zwecke technisch Zugriff auf alle gespeicherten
            Daten. Dieser Zugriff wird ausschließlich zur Fehlerbehebung, zur Erfüllung
            deiner Rechte nach §8 oder im Fall eines Sicherheitsvorfalls genutzt — niemals
            zur kommerziellen Auswertung.
          </p>
        </div>

        <p className="mt-8 text-xs text-ink-soft">
          Stand: {new Date().getFullYear()}
        </p>
      </section>
    </main>
  );
}
