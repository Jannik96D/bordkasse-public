import Link from "next/link";
import {
  Compass,
  Anchor,
  Sailboat,
  Wallet,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { AboutExplorer, type ExplorerPhase } from "./about-explorer";

export const metadata = {
  title: "Über die Bordkassen-App · Bordkasse",
  description:
    "Was die Bordkassen-App kann — von der Crew-Verwaltung über die fünf Aufteilungs-Arten bis zur automatischen Datenlöschung.",
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
    lead: "Ein klarer Startbildschirm — anmelden oder zuerst nachlesen, wozu die App da ist.",
    body: (
      <>
        <p>
          Wer noch kein Konto hat, sieht hier nur das Logo, einen
          Anmelden-Button und einen kurzen Hinweis zur Installation. Kein
          unnötiger Schnickschnack.
        </p>
        <p className="mt-2">
          Die App funktioniert sowohl auf <strong>Android</strong> als auch
          auf <strong>iOS</strong>. Auf beiden Systemen lässt sie sich direkt
          aus dem Browser heraus auf den Startbildschirm legen — danach
          startet sie wie eine ganz normale App. Eine Installation aus dem
          App Store oder Play Store ist nicht nötig.
        </p>
      </>
    ),
    screenshot: "/about/01-welcome.webp",
    alt: "Startbildschirm der Bordkasse mit Logo und Anmelden-Button",
  },
  {
    id: "anmelden",
    title: "Anmelden per Login-Link",
    lead: "Kein Passwort, keine Hürde — du gibst deine E-Mail-Adresse an, bekommst einen Login-Link in dein Postfach und bist drin.",
    body: (
      <>
        <p>
          Der Link ist 60 Minuten gültig und funktioniert nur einmal. Falls
          die Mail nicht ankommt, kannst du nach 30 Sekunden eine neue
          anfordern.
        </p>
      </>
    ),
    screenshot: "/about/02-login.webp",
    alt: "Login-Bildschirm mit E-Mail-Eingabe für den Login-Link",
  },
  {
    id: "toerns",
    title: "Törn-Übersicht",
    lead: "Alle deine Törns auf einen Blick — laufende und archivierte.",
    body: (
      <>
        <p>
          Jede Kachel zeigt Reisedaten, Schiffsname und wie viele Personen
          mitsegeln. Wer einen <strong>Skipper</strong>- oder
          <strong> Admin</strong>-Zugang hat, sieht oben einen Button, um
          einen neuen Törn anzulegen. Crew-Mitglieder sehen nur die Törns,
          zu denen sie eingeladen wurden.
        </p>
      </>
    ),
    screenshot: "/about/03-trips.webp",
    alt: "Liste aller eigenen Törns",
  },
  {
    id: "trip-overview",
    title: "Übersicht pro Törn",
    lead: "Pro Törn ein eigener Bereich: Schnellzugriff auf Buchungen, Bilanz, Anzahlungen und Schulden.",
    body: (
      <>
        <p>
          Die Navigations-Leiste am unteren Bildschirmrand bleibt immer
          sichtbar, damit auch im Hafen-Trubel alle Bereiche schnell
          erreichbar sind. Der große Plus-Button unten rechts öffnet die
          Eingabemaske für eine neue Buchung in einem Schritt.
        </p>
        <p className="mt-2">
          Sobald der Törn vorbei ist, erscheint oben ein Hinweis-Banner:
          „Kaution prüfen + Abrechnung verschicken“. Skipper und Admins
          können auf einen Klick allen Beteiligten eine E-Mail mit der
          fertigen Abrechnung schicken. Bei nachträglichen Änderungen
          erinnert die App, eine Update-Mail rauszuschicken — und für
          Yacht-Anzahlungen verschickt sie 3 Tage vor jeder Frist
          selbstständig Erinnerungen.
        </p>
      </>
    ),
    screenshot: "/about/04-trip-overview.webp",
    alt: "Übersicht eines anstehenden Törns mit Crew-Zähler, Schnellzugriff-Kacheln und Navigations-Leiste",
  },
  {
    id: "buchungen",
    title: "Buchungs-Liste",
    lead: "Alle Ausgaben und Gutschriften, nach Datum sortiert — wer hat was bezahlt, mit welcher Aufteilung. So bleibt für alle nachvollziehbar, wohin das Geld geht.",
    body: (
      <>
        <p>
          Pro Eintrag siehst du Beschreibung, Betrag, wer bezahlt hat,
          welche Aufteilung gewählt wurde und welche Kategorie. Gutschriften
          sind farblich abgesetzt. Ein Tipper öffnet die Bearbeitung —
          ändern darf der Ersteller, Skipper und Admin.
        </p>
      </>
    ),
    screenshot: "/about/05-buchungen.webp",
    alt: "Buchungs-Liste eines laufenden Törns",
  },
  {
    id: "buchung-neu",
    title: "Ausgaben eintragen — fünf Aufteilungs-Arten",
    lead: "Jede Ausgabe lässt sich auf fünf Arten verteilen: Gleichmäßig, nur An-Bord-Anwesende, Zeitanteilig, Individuell oder Pro Person.",
    body: (
      <>
        <p>
          „<strong>Pro Person</strong>“ ist für Restaurants, in denen von
          einer Person für alle gezahlt wird, jedoch jede:r die eigene
          Bestellung zahlt. Du musst die Rechnungssumme nicht extra
          eingeben — und vor allem kein Kopfrechnen, keine Nebenrechnungen,
          kein Taschenrechner. Du tippst die Einzelposten
          pro Person einfach vom Beleg ab, z. B.{" "}
          <em>Getränke 3,50 €</em> und <em>Essen 13 €</em> für Anna, dann{" "}
          <em>Getränke 4 €</em> und <em>Essen 15,80 €</em> für Ben — die
          App summiert das automatisch zum Gesamtbetrag jeder Person
          und zur Rechnungssumme. Das <strong>Trinkgeld</strong> kommt in
          ein eigenes Feld und wird anschließend auf alle Beteiligten
          umgelegt (wahlweise im Verhältnis zum jeweiligen Rechnungsbetrag
          oder gleichmäßig pro Kopf).
        </p>
        <p className="mt-2">
          Zusätzlich gibt es einen <strong>Alkohol-Anteil</strong> (unter
          „Erweitert“): Den Alkohol-Teil eines Belegs zahlen nur diejenigen,
          die als Trinker eingetragen sind. Der Rest läuft nach der
          gewählten Aufteilung. Das Komma im Betrag versteht die App
          selbstverständlich auf Deutsch.
        </p>
      </>
    ),
    screenshot: "/about/06-buchung-neu.webp",
    alt: "Neue Buchung anlegen mit Aufteilungs-Auswahl",
  },
  {
    id: "bilanz",
    title: "Bilanz",
    lead: "Wer hat insgesamt mehr gezahlt als verbraucht, wer weniger — der Saldo wird laufend aus allen Buchungen berechnet.",
    body: (
      <>
        <p>
          Grün heißt: bekommt Geld zurück. Rot heißt: zahlt nach. Die Summe
          aller Salden ergibt immer null. Alle Crew-Mitglieder können die
          Bilanz einsehen — Transparenz für die ganze Crew.
        </p>
      </>
    ),
    screenshot: "/about/07-bilanz.webp",
    alt: "Bilanz-Übersicht mit Saldo pro Person",
  },
  {
    id: "schulden",
    title: "Schulden — möglichst wenige Überweisungen",
    lead: "Statt dass jeder an jeden zahlt, rechnet die App den Zahlungsplan auf die kleinstmögliche Anzahl Überweisungen herunter.",
    body: (
      <>
        <p>
          Wer noch Geld bekommt und wer noch nachzahlen muss, wird so
          zusammengefasst, dass die Crew mit wenigen Überweisungen
          fertig ist. Jede Zahlung kann mit einem Häkchen als „bezahlt“
          markiert werden — alle in der Crew sehen den Stand sofort. Das
          Häkchen setzen dürfen nur die beiden direkt Beteiligten
          (Schuldner und Empfänger) sowie der Skipper oder Admin.
        </p>
        <p className="mt-2">
          Sobald ein Häkchen gesetzt wird, gehen automatisch
          Bestätigungs-Mails an Schuldner und Empfänger. Wenn ein Admin
          stellvertretend abhakt, bekommen Skipper und Vorstrecker
          zusätzlich eine Info-Mail — damit niemand übersieht, dass
          jemand anderes in seinem Trip-Kontext geklickt hat.
        </p>
      </>
    ),
    screenshot: "/about/08-schulden.webp",
    alt: "Schulden-Übersicht mit Bezahlt-Häkchen",
  },
  {
    id: "statistik",
    title: "Auswertung der Ausgaben",
    lead: "Wie viel haben wir für Sprit ausgegeben? Welche Kategorie war am teuersten? — pro Törn aufgeschlüsselt.",
    body: (
      <>
        <p>
          Alle Crew-Mitglieder können die Statistik einsehen. Sie bleibt
          auch nach der automatischen Datenlöschung in anonymisierter Form
          erhalten — also Beträge, Kategorien und Tage, aber ohne
          Personen-Bezug. So kannst du auch Jahre später noch nachsehen,
          wie ein vergangener Törn finanziell aussah.
        </p>
      </>
    ),
    screenshot: "/about/09-statistik.webp",
    alt: "Statistik-Bereich mit Auswertung nach Kategorie",
  },
  {
    id: "crew",
    title: "Crew einladen und verwalten",
    lead: "Skipper und Admins laden die Crew per E-Mail ein — oder tragen Personen ohne eigenen Login als Platzhalter ein.",
    body: (
      <>
        <p>
          Wenn jemand keinen eigenen Login möchte (Eltern, Kinder, Freunde
          ohne Lust auf Apps), legt der Skipper einfach einen Platzhalter
          an. Pro Person werden der Anwesenheits-Zeitraum (An Bord ab/bis),
          ein Häkchen für „trinkt Alkohol“ und optional eine Notiz
          hinterlegt. Co-Skipper können beim Verwalten helfen. Alle
          Crew-Mitglieder sehen die Liste, bearbeiten dürfen aber nur die
          eigenen Daten — der Rest bleibt dem Skipper vorbehalten.
        </p>
      </>
    ),
    screenshot: "/about/10-crew.webp",
    alt: "Crew-Verwaltung mit Anwesenheits-Zeiten und Alkohol-Häkchen",
  },
  {
    id: "kategorien",
    title: "Ausgaben übersichtlich einordnen",
    lead: "Lebensmittel 🛒, Sprit ⛽, Yacht ⛵, Hafen ⚓ — pro Törn frei wählbar aus einem Satz vorgefertigter Symbole.",
    body: (
      <>
        <p>
          Eine Grund-Auswahl ist voreingestellt. Skipper und Admins können
          Kategorien umbenennen, löschen oder neue hinzufügen. Jede
          Kategorie taucht später in der Statistik wieder auf.
        </p>
      </>
    ),
    screenshot: "/about/11-kategorien.webp",
    alt: "Kategorien-Verwaltung mit Symbol-Auswahl",
  },
  {
    id: "gutschrift",
    title: "Gutschriften",
    lead: "Wenn jemand außerhalb der Bordkasse gezahlt hat — z. B. die Yacht-Vorauszahlung — wird das als Gutschrift verrechnet.",
    body: (
      <>
        <p>
          Eine Gutschrift kann direkt von Person zu Person laufen, oder
          „An Alle“ — letzteres, wenn jemand vorab für die ganze Crew
          bezahlt hat. Damit nichts versehentlich doppelt verbucht wird,
          dürfen Gutschriften nur Skipper und Admins eintragen.
        </p>
      </>
    ),
    screenshot: "/about/12-gutschrift.webp",
    alt: "Gutschrift-Formular mit „Zahlt“ und „Empfängt“ Auswahl",
  },
  {
    id: "anzahlung-setup",
    title: "Yacht-Anzahlung — Plan einrichten",
    lead: "Wenn der Skipper Monate vor dem Törn die Charter-Anzahlung an die Agentur leistet, hilft die App, das Geld bei der Crew einzusammeln.",
    body: (
      <>
        <p>
          Im Anzahlungs-Wizard wird zuerst festgelegt, wie sich die
          Gesamtsumme auf die Crew verteilt — <strong>gleichmäßig</strong>,{" "}
          <strong>zeitanteilig</strong>, <strong>individuell</strong>{" "}
          oder nach <strong>Kojen</strong> (jede Kabine bekommt einen
          eigenen Preis, Crew-Mitglieder werden den Kabinen zugewiesen).
          Wer das Geld vorstreckt, ist meistens der Skipper, kann aber
          auch jemand anderes sein („Vorstrecker“). An diese Person zahlt
          die Crew dann.
        </p>
        <p className="mt-2">
          Im zweiten Schritt werden die <strong>Tranchen</strong> definiert
          — typischerweise 30 % Reservierungs-Anzahlung Monate vorab und
          70 % Endzahlung kurz vor dem Törn. Die Summe muss 100 % ergeben.
          Eine WhatsApp-Vorlage und eine optionale Wero-ID lassen sich
          ebenfalls hier hinterlegen.
        </p>
      </>
    ),
    screenshot: "/about/15-anzahlung-setup.webp",
    alt: "Anzahlungs-Wizard mit Tranchen-Editor (Datum, Label, Prozent)",
  },
  {
    id: "anzahlung-matrix",
    title: "Anzahlungs-Matrix — wer hat wann was gezahlt",
    lead: "Eine Person-mal-Tranche-Tabelle mit Status-Symbolen: offen, teilweise, bezahlt, überfällig, gemeldet aber unbestätigt.",
    body: (
      <>
        <p>
          Ein Klick auf eine Zelle öffnet ein Modal zum Erfassen einer
          Zahlung. Überschuss kann automatisch auf die nächste Tranche
          übertragen werden. Mit dem <strong>🔔-Symbol</strong> in der
          Zeile schickt der Skipper eine persönliche Erinnerungs-Mail
          mit Wero-ID und Verwendungszweck; mit dem{" "}
          <strong>💬-Symbol</strong> bekommt er einen
          WhatsApp-Vorschlagstext zum Kopieren.
        </p>
        <p className="mt-2">
          Ein Fortschritts-Balken oben zeigt auf einen Blick, wie viel
          schon eingegangen ist. Auf dem Smartphone erscheint jede Person
          als eigene Karte — kein horizontales Wischen nötig; am größeren
          Bildschirm bleibt die Tabelle für den Quervergleich.
        </p>
        <p className="mt-2">
          Daneben sieht der Vorstrecker eine Übersicht, was er noch an die
          Charter-Agentur überweisen muss — basierend auf dem, was die
          Crew schon bei ihm eingezahlt hat. 3 Tage vor jeder
          Charter-Frist verschickt die App diese Übersicht zusätzlich
          per Mail; 3 Tage vor der Crew-Frist gehen automatisch
          Erinnerungen an alle Crew-Mitglieder mit offenem Betrag.
        </p>
      </>
    ),
    screenshot: "/about/16-anzahlung-matrix.webp",
    alt: "Anzahlungs-Matrix als Karten-Ansicht mit Fortschritts-Header, Charter-Hinweis und Pending-Bestätigung",
  },
  {
    id: "anzahlung-crew-self",
    title: "Crew meldet selbst",
    lead: "Crew-Mitglieder sehen ihre eigenen Anzahlungen und können mit einem Klick melden, dass sie überwiesen haben.",
    body: (
      <>
        <p>
          Statt dass der Skipper jeden Eingang manuell abhaken muss, kann
          die Crew selbst „Ich habe gezahlt“ drücken. Der Vorstrecker
          bekommt eine Mail und sieht in der Matrix ein gelbes
          ⏳-Symbol — er bestätigt mit ✓, sobald das Geld auf seinem Konto
          ist, oder lehnt mit ✗ ab. Erst nach Bestätigung zählt die
          Zahlung in der Bilanz.
        </p>
        <p className="mt-2">
          Sobald der Vorstrecker bestätigt oder ablehnt, bekommt das
          Crew-Mitglied eine kurze Info-Mail. Bei einer Ablehnung
          enthält die Mail einen Hinweis, mit dem Skipper Rücksprache zu
          halten.
        </p>
        <p className="mt-2">
          Anzahlungen tauchen für Crew-Mitglieder nur in der Navigation
          auf, solange sie selbst noch etwas offen haben — ist alles
          bezahlt, verschwindet der Punkt wieder. So bleibt die App für
          alle anderen aufgeräumt.
        </p>
      </>
    ),
    screenshot: "/about/17-anzahlung-crew-self.webp",
    alt: "Crew-Self-View mit „Ich habe gezahlt“-Button pro offener Tranche",
  },
  {
    id: "offline",
    title: "Funktioniert auch ohne Internet",
    lead: "Auf der Yacht ist Empfang Glückssache — die App funktioniert trotzdem.",
    body: (
      <>
        <p>
          Buchungen, die du ohne Internet eingibst, werden auf dem Gerät
          zwischengespeichert und automatisch übertragen, sobald wieder
          Empfang da ist. Ein dezenter Hinweis oben am Bildschirm zeigt,
          dass du gerade offline arbeitest. Die App lässt sich auf dem
          Smartphone wie eine echte App installieren — du brauchst nicht
          jedes Mal den Browser aufmachen.
        </p>
      </>
    ),
    screenshot: "/about/13-offline.webp",
    alt: "Buchungs-Liste mit Offline-Hinweis oben",
  },
  {
    id: "dsgvo",
    title: "Automatische Datenlöschung",
    lead: "30 Tage nach Törn-Ende werden alle personenbezogenen Daten automatisch entfernt.",
    body: (
      <>
        <p>
          Crew-Liste, Buchungen mit Personen-Bezug, Gutschriften, die
          Änderungs-Historie — alles wird automatisch gelöscht. Was bleibt,
          ist eine anonymisierte Statistik ohne Personen-Bezug. Die Details
          stehen in der{" "}
          <Link href="/datenschutz" className="underline">
            Datenschutzerklärung
          </Link>
          .
        </p>
      </>
    ),
    screenshot: "/about/14-dsgvo.webp",
    alt: "Datenschutz-Abschnitt zur 30-Tage-Löschung nach Törn-Ende",
  },
];

// Anzeige-Reihenfolge nach typischem Törn-Ablauf, in 5 Phasen gruppiert.
// Jede Phase bekommt eine Sektion mit kurzem Lead und einer Karten-Liste.
type PhaseId =
  | "loslegen"
  | "vor-dem-toern"
  | "waehrend-des-toerns"
  | "abrechnung"
  | "datenschutz";

interface Phase {
  id: PhaseId;
  Icon: LucideIcon;
  title: string;
  lead: string;
  featureIds: string[];
}

const PHASES: Phase[] = [
  {
    id: "loslegen",
    Icon: Compass,
    title: "Loslegen",
    lead: "Anmelden ohne Passwort, eigene Törns im Überblick.",
    featureIds: ["welcome", "anmelden", "toerns", "trip-overview"],
  },
  {
    id: "vor-dem-toern",
    Icon: Anchor,
    title: "Vor dem Törn",
    lead: "Crew einladen, Kategorien festlegen, optional Yacht-Anzahlung mit Tranchen.",
    featureIds: ["crew", "kategorien", "anzahlung-setup", "anzahlung-matrix", "anzahlung-crew-self"],
  },
  {
    id: "waehrend-des-toerns",
    Icon: Sailboat,
    title: "Während des Törns",
    lead: "Ausgaben erfassen — auch ohne Internet — und sehen, was ihr ausgebt.",
    featureIds: ["buchungen", "buchung-neu", "gutschrift", "offline", "statistik"],
  },
  {
    id: "abrechnung",
    Icon: Wallet,
    title: "Abrechnung",
    lead: "Saldo pro Person, möglichst wenige Überweisungen, Häkchen für „bezahlt“.",
    featureIds: ["bilanz", "schulden"],
  },
  {
    id: "datenschutz",
    Icon: ShieldCheck,
    title: "Datenschutz",
    lead: "Personenbezogene Daten verschwinden 30 Tage nach Törn-Ende automatisch.",
    featureIds: ["dsgvo"],
  },
];

function featureById(id: string): Feature {
  const found = features.find((f) => f.id === id);
  if (!found) throw new Error(`Feature mit id="${id}" fehlt in features[].`);
  return found;
}

export default function AboutPage() {
  const phasesData: ExplorerPhase[] = PHASES.map((phase) => ({
    id: phase.id,
    title: phase.title,
    lead: phase.lead,
    icon: <phase.Icon className="h-5 w-5" aria-hidden="true" />,
    features: phase.featureIds.map(featureById),
  }));

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <div className="mb-6">
        <Link href="/" className="text-sm text-ink-soft hover:text-primary">
          ← Übersicht
        </Link>
      </div>

      <h1 className="text-3xl font-bold text-primary">
        Wer schuldet am Ende wem? Diese App rechnet&rsquo;s aus.
      </h1>
      <p className="mt-2 text-base text-ink-soft">
        Faire Aufteilung gemeinsamer Kosten auf Segel-Törns — auch wenn die
        Crew wechselt, manche keinen Alkohol trinken und einzelne erst
        später dazustoßen oder früher von Bord gehen.
      </p>

      <section className="prose mt-8 max-w-none text-sm leading-relaxed">
        <p>
          Die App ist gedacht für Skipper und ihre Crews, die nicht jede
          Ausgabe von Hand in eine Tabelle tippen wollen. Sie läuft auf dem
          Smartphone, das Anmelden geht ohne Passwort (Login-Link per
          E-Mail), und sie rechnet faire Salden auch dann, wenn
          Crew-Mitglieder zu unterschiedlichen Zeiten an und von Bord
          gehen.
        </p>
      </section>

      <AboutExplorer phases={phasesData} />

      <section className="mt-16 rounded-lg border border-rule bg-paper-soft p-6">
        <h2 className="text-lg font-semibold text-primary">
          Was die App <em>nicht</em> ist
        </h2>
        <ul className="mt-3 ml-5 list-disc space-y-1 text-sm text-ink-soft">
          <li>
            Kein kommerzielles Produkt — ein privates Werkzeug für eigene
            Törns.
          </li>
          <li>Keine Tracking-, Analyse- oder Werbe-Cookies.</li>
          <li>
            Keine Datenweitergabe an Dritte außerhalb der nötigen
            technischen Infrastruktur (siehe Datenschutz).
          </li>
        </ul>
      </section>

      <section className="mt-12 text-center">
        <p className="text-sm text-ink-soft">Mit an Bord?</p>
        <Link
          href="/login"
          className="mt-3 inline-flex items-center justify-center rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-paper shadow-sm transition hover:bg-navy-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
        >
          Anmelden
        </Link>
      </section>

      <p className="mt-12 text-center text-xs text-ink-soft">
        <Link href="/datenschutz" className="hover:text-primary">
          Datenschutz
        </Link>
      </p>
    </main>
  );
}
