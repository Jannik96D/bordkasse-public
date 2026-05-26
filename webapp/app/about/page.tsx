import Link from "next/link";

export const metadata = {
  title: "Über die Bordkassen-App · Bordkasse",
  description:
    "Was die Bordkassen-App kann — von der Crew-Verwaltung über die vier Aufteilungslogiken bis zum DSGVO-Auto-Purge.",
};

type Feature = {
  id: string;
  title: string;
  lead: string;
  body: React.ReactNode;
  screenshot: string;
  alt: string;
};

const features: Feature[] = [
  {
    id: "welcome",
    title: "Willkommen an Bord",
    lead: "Ein klarer Startbildschirm — entweder anmelden oder direkt mehr über die App erfahren.",
    body: (
      <>
        <p>
          Wer noch kein Konto hat, sieht hier nur das Logo, einen
          Anmelden-Button und einen Hinweis auf die App-Installation. Kein
          Marketing-Geblubber, keine Banner.
        </p>
      </>
    ),
    screenshot: "/about/01-welcome.png",
    alt: "Startbildschirm der Bordkasse mit Logo und Anmelden-Button",
  },
  {
    id: "anmelden",
    title: "Anmelden per Magic-Link",
    lead: "Kein Passwort, keine Hürde — du gibst deine E-Mail an, klickst den Link in der Mail und bist drin.",
    body: (
      <>
        <p>
          Magic-Links sind 60 Minuten gültig und nur einmalig nutzbar. Nach
          30&nbsp;Sekunden kannst du eine neue Mail anfordern, falls die erste
          nicht ankommt.
        </p>
      </>
    ),
    screenshot: "/about/02-login.png",
    alt: "Login-Bildschirm mit E-Mail-Eingabe für den Magic-Link",
  },
  {
    id: "toerns",
    title: "Törn-Übersicht",
    lead: "Alle deine Törns auf einen Blick — aktiv, archiviert, und (für Admins) auch fremde Törns.",
    body: (
      <>
        <p>
          Jede Törn-Kachel zeigt Reisedaten, Schiffsname und Crew-Größe.
          Skipper sehen oben einen Button zum Anlegen neuer Törns.
        </p>
      </>
    ),
    screenshot: "/about/03-trips.png",
    alt: "Liste aller eigenen Törns",
  },
  {
    id: "trip-overview",
    title: "Trip-Cockpit",
    lead: "Pro Törn ein eigenes Cockpit: Schnellzugriff auf Buchungen, Bilanz, Statistik und Schulden.",
    body: (
      <>
        <p>
          Die feste Bottom-Navigation bleibt überall sichtbar — Daumen-freundlich
          auch im Hafen-Trubel. Der dicke Plus-Button schwebt unten rechts und
          öffnet die Buchungs-Eingabe in einem Schritt. Nach Törn-Ende
          erscheint oben ein Banner mit „Kaution prüfen + Abrechnung
          verschicken" — die Crew bekommt dann eine Mail mit allen offenen
          Schulden.
        </p>
      </>
    ),
    screenshot: "/about/04-trip-overview.png",
    alt: "Trip-Cockpit mit Settlement-Banner, Schnellzugriff und Bottom-Navigation",
  },
  {
    id: "buchungen",
    title: "Buchungs-Liste",
    lead: "Alle Ausgaben und Gutschriften, chronologisch — wer hat was bezahlt, mit welcher Aufteilungslogik.",
    body: (
      <>
        <p>
          Pro Eintrag siehst du Beschreibung, Betrag, Zahler, Aufteilungslogik
          und Kategorie. Gutschriften sind farblich abgesetzt. Tippen öffnet
          die Bearbeitung.
        </p>
      </>
    ),
    screenshot: "/about/05-buchungen.png",
    alt: "Buchungs-Liste eines laufenden Törns",
  },
  {
    id: "buchung-neu",
    title: "Ausgaben buchen — 5 Aufteilungslogiken",
    lead: "Jede Ausgabe lässt sich auf fünf Arten verteilen: Gleichmäßig, nur An-Bord-Anwesende, Zeitanteilig, Individuell oder Pro Person.",
    body: (
      <>
        <p>
          „<strong>Pro Person</strong>" ist für Restaurants, in denen jede:r
          die eigene Bestellung zahlt — der Gesamtbetrag ergibt sich aus den
          Einzelbeträgen pro Person. Zusätzlich gibt es einen{" "}
          <strong>Alkohol-Anteil</strong> (unter „Erweitert"): Den
          Alkohol-Teil eines Belegs zahlen nur die Trinker, der Rest läuft
          nach der gewählten Aufteilung. Das Komma im Betrag versteht die App
          selbstverständlich auf Deutsch.
        </p>
      </>
    ),
    screenshot: "/about/06-buchung-neu.png",
    alt: "Neue Buchung anlegen mit Aufteilungs-Auswahl",
  },
  {
    id: "bilanz",
    title: "Bilanz",
    lead: "Wer hat insgesamt mehr gezahlt als verbraucht, wer weniger — der Saldo wird live aus allen Buchungen berechnet.",
    body: (
      <>
        <p>
          Grün = bekommt Geld zurück. Rot = zahlt nach. Die Summe aller Salden
          ist immer null.
        </p>
      </>
    ),
    screenshot: "/about/07-bilanz.png",
    alt: "Bilanz-Übersicht mit Saldo pro Person",
  },
  {
    id: "schulden",
    title: "Schulden — minimale Überweisungen",
    lead: "Statt jeder zahlt an jeden: Ein Greedy-Algorithmus reduziert das auf maximal N−1 Überweisungen bei N Personen.",
    body: (
      <>
        <p>
          Jede Zahlung kann mit einem Häkchen als „bezahlt“ markiert werden —
          synchron für die ganze Crew in Echtzeit. Nur Schuldner, Gläubiger
          oder Admin dürfen togglen.
        </p>
      </>
    ),
    screenshot: "/about/08-schulden.png",
    alt: "Schulden-Übersicht mit Bezahlt-Häkchen",
  },
  {
    id: "statistik",
    title: "Statistik",
    lead: "Wie viel haben wir für Sprit ausgegeben? Welche Kategorie war am teuersten? — pro Törn aufgeschlüsselt.",
    body: (
      <>
        <p>
          Die Statistik bleibt auch nach der DSGVO-Löschung anonymisiert
          erhalten: Beträge, Kategorien und Tage, aber ohne Personen-Bezug —
          du kannst Jahre später noch nachschauen.
        </p>
      </>
    ),
    screenshot: "/about/09-statistik.png",
    alt: "Statistik-Tab mit Auswertung nach Kategorie",
  },
  {
    id: "crew",
    title: "Crew einladen & verwalten",
    lead: "Crew-Mitglieder per E-Mail einladen — oder als „Ghost-Person“ für jemanden, der keine App will, mitführen.",
    body: (
      <>
        <p>
          Pro Person hinterlegst du Anwesenheits-Zeitraum (An Bord ab/bis),
          Alkohol-Flag (Weinglas) und Notizen. Co-Skipper helfen beim
          Verwalten, Crew-Mitglieder sehen die anderen, aber bearbeiten nur
          eigene Daten.
        </p>
      </>
    ),
    screenshot: "/about/10-crew.png",
    alt: "Crew-Verwaltung mit Anwesenheits-Zeiten und Alkohol-Flag",
  },
  {
    id: "kategorien",
    title: "Kategorien mit Icons",
    lead: "Lebensmittel 🛒, Sprit ⛽, Yacht ⛵, Hafen ⚓ — pro Törn frei wählbar aus einem kuratierten Icon-Set.",
    body: (
      <>
        <p>
          Default-Kategorien sind vorgegeben, du kannst sie umbenennen, löschen
          oder neue hinzufügen. Jede Kategorie taucht später in der Statistik
          wieder auf.
        </p>
      </>
    ),
    screenshot: "/about/11-kategorien.png",
    alt: "Kategorien-Verwaltung mit Icon-Picker",
  },
  {
    id: "gutschrift",
    title: "Gutschriften",
    lead: "Wenn jemand außerhalb der Bordkasse gezahlt hat — z. B. die Yacht-Vorauszahlung — wird das als Gutschrift verrechnet.",
    body: (
      <>
        <p>
          Direkt von Person zu Person oder pauschal „An Alle“, wenn jemand
          vorab für die ganze Crew bezahlt hat. Nur Skipper und Admins können
          Gutschriften eintragen, damit nichts versehentlich doppelt landet.
        </p>
      </>
    ),
    screenshot: "/about/12-gutschrift.png",
    alt: "Gutschrift-Formular mit „Zahlt“ und „Empfängt“ Auswahl",
  },
  {
    id: "offline",
    title: "Offline-fähig (PWA)",
    lead: "Auf der Yacht ist Empfang Glückssache — die App funktioniert trotzdem.",
    body: (
      <>
        <p>
          Buchungen, die du offline eingibst, landen in einer lokalen Outbox
          und werden automatisch synchronisiert, sobald wieder Netz da ist.
          Ein dezenter Banner oben zeigt den Offline-Modus an. Die App lässt
          sich auf dem Smartphone wie eine native App installieren.
        </p>
      </>
    ),
    screenshot: "/about/13-offline.png",
    alt: "Buchungs-Liste mit Offline-Banner oben",
  },
  {
    id: "dsgvo",
    title: "Automatische DSGVO-Löschung",
    lead: "30 Tage nach Törn-Ende werden alle personenbezogenen Daten automatisch entfernt.",
    body: (
      <>
        <p>
          Crew-Liste, Buchungen mit Personen-Bezug, Gutschriften, Audit-Log —
          alles weg. Was bleibt, ist eine anonymisierte Statistik. Details
          stehen in der{" "}
          <Link href="/datenschutz" className="underline">
            Datenschutzerklärung
          </Link>
          .
        </p>
      </>
    ),
    screenshot: "/about/14-dsgvo.png",
    alt: "Datenschutz-Abschnitt zur 30-Tage-Löschung nach Törn-Ende",
  },
];

export default function AboutPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10">
      <div className="mb-6">
        <Link href="/" className="text-sm text-ink-soft hover:text-primary">
          ← Übersicht
        </Link>
      </div>

      <h1 className="text-3xl font-bold text-primary">
        Über die Bordkassen-App
      </h1>
      <p className="mt-2 text-base text-ink-soft">
        Faire Aufteilung gemeinsamer Kosten auf Segel-Törns — auch wenn die
        Crew wechselt, manche nicht trinken und der eine erst halb so lang an
        Bord war.
      </p>

      <section className="prose mt-8 max-w-none text-sm leading-relaxed">
        <p>
          Die App ist gedacht für Skipper und Crews, die nicht jede Ausgabe
          per Hand in eine Excel-Tabelle tippen wollen. Sie funktioniert auf
          dem Smartphone, ohne Login-Hürde (Magic-Link), und rechnet faire
          Salden auch dann, wenn Crewmitglieder zu unterschiedlichen Zeiten
          ein- und aussteigen.
        </p>
      </section>

      <ol className="mt-12 space-y-16">
        {features.map((f, idx) => (
          <li key={f.id} id={f.id} className="scroll-mt-6">
            <div className="mb-3 flex items-baseline gap-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-gold">
                {String(idx + 1).padStart(2, "0")}
              </span>
              <h2 className="text-xl font-bold text-primary">{f.title}</h2>
            </div>
            <p className="text-base text-ink">{f.lead}</p>
            <div className="prose mt-3 max-w-none text-sm leading-relaxed text-ink-soft">
              {f.body}
            </div>
            <figure className="mt-5 overflow-hidden rounded-lg border border-rule bg-paper-soft">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={f.screenshot}
                alt={f.alt}
                loading="lazy"
                className="block w-full h-auto"
              />
              <figcaption className="border-t border-rule px-4 py-2 text-xs text-ink-soft">
                {f.alt}
              </figcaption>
            </figure>
          </li>
        ))}
      </ol>

      <section className="mt-16 rounded-lg border border-rule bg-paper-soft p-6">
        <h2 className="text-lg font-semibold text-primary">
          Was die App <em>nicht</em> ist
        </h2>
        <ul className="mt-3 ml-5 list-disc space-y-1 text-sm text-ink-soft">
          <li>Kein kommerzielles Produkt — privates Tool für eigene Törns.</li>
          <li>Keine Tracking-, Analyse- oder Werbe-Cookies.</li>
          <li>
            Keine Datenweitergabe an Dritte außerhalb der notwendigen
            Infrastruktur (siehe Datenschutz).
          </li>
        </ul>
      </section>

      <p className="mt-12 text-center text-xs text-ink-soft">
        <Link href="/datenschutz" className="hover:text-primary">
          Datenschutz
        </Link>
      </p>
    </main>
  );
}
