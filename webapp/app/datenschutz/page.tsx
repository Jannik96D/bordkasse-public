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
              <strong>E-Mail-Adresse</strong> — für Login per Magic-Link und Crew-Einladungen
            </li>
            <li>
              <strong>Anzeigename</strong> — wie du auf Buchungen + Bilanz erscheinst
            </li>
            <li>
              <strong>Optionales Profil-Flag</strong> „Alkohol-Trinker“ — beeinflusst, wer den
              Alkohol-Anteil bei Ausgaben mitträgt
            </li>
            <li>
              <strong>Trip-Daten</strong> — Crew, Anwesenheits-Tage, Buchungen, Beträge,
              Aufteilungen — geteilt nur mit den Crew-Mitgliedern dieses Trips
            </li>
            <li>
              <strong>Server-Logs</strong> — IP-Adresse, Zeitstempel, User-Agent, kurzfristig
              gespeichert zur Fehlersuche und Missbrauchsabwehr
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
            Profil-Informationen werden gespeichert, solange du in mindestens einem
            aktiven Törn als Mitglied geführt bist.
          </p>
          <p className="mt-2">
            <strong>Automatische Löschung 30 Tage nach Törn-Ende, sobald alle Zahlungen erledigt sind:</strong>{" "}
            Wenn ein Törn seit mehr als 30 Tagen beendet ist, der Skipper die Abrechnung
            verschickt hat und alle Zahlungen in der App als erledigt markiert sind, werden
            die personenbezogenen Daten zu diesem Törn automatisch gelöscht — namentlich:
          </p>
          <ul className="ml-5 mt-2 list-disc">
            <li>Crew-Liste (wer war wann an Bord, Alkohol-Flag, Notizen)</li>
            <li>Buchungen mit Personen-Bezug (wer hat bezahlt, wer ist beteiligt)</li>
            <li>Gutschriften und „Bezahlt“-Markierungen</li>
            <li>Audit-Log-Einträge dieses Törns</li>
            <li>Ghost-Personen, die nirgends mehr Mitglied sind</li>
          </ul>
          <p className="mt-2">
            Solange noch offene Schulden in der App stehen, bleiben die Daten erhalten —
            sonst gingen die laufenden Zahlungen verloren. Skipper und Admin können die
            Löschung über die Trip-Einstellungen jederzeit auch früher anstoßen, sobald
            alle Zahlungen erledigt sind.
          </p>
          <p className="mt-2">
            <strong>Was bleibt:</strong> Eine anonymisierte Statistik-Kopie (Datum,
            Kategorie, Gesamtbetrag pro Tag und Kategorie) — ohne jeglichen Personenbezug.
            Sie erlaubt dir, im Statistik-Tab auch Jahre später noch zu sehen, wie viel
            insgesamt z. B. für „Sprit“ oder „Restaurant“ ausgegeben wurde, ohne dass
            erkennbar ist, wer beteiligt war oder wer gezahlt hat.
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
          <h2 className="text-base font-semibold">7. Deine Rechte</h2>
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
            Wende dich für die Wahrnehmung dieser Rechte formlos an{" "}
            <a href="mailto:bordkasse@dieter.ms" className="underline">
              bordkasse@dieter.ms
            </a>
            .
          </p>
        </div>

        <div>
          <h2 className="text-base font-semibold">8. Datensicherheit</h2>
          <p>
            Die Übertragung erfolgt verschlüsselt via HTTPS/TLS. Datenbank-Zugriffe sind
            durch Row-Level-Security so eingeschränkt, dass jedes Crew-Mitglied nur Daten
            seiner eigenen Trips sehen kann.
          </p>
        </div>

        <p className="mt-8 text-xs text-ink-soft">
          Stand: {new Date().getFullYear()}
        </p>
      </section>
    </main>
  );
}
