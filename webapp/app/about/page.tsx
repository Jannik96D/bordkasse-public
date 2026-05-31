import Link from "next/link";
import {
  Compass,
  Anchor,
  Sailboat,
  Wallet,
  History,
  ShoppingCart,
  Fuel,
  Bell,
  MessageCircle,
  Check,
  X,
  type LucideIcon,
} from "lucide-react";
import { AboutExplorer, type ExplorerPhase, type FeatureRole } from "./about-explorer";

// Inline-Icon im Fließtext — dieselben lucide-Strich-Icons wie in der App,
// damit Symbole in der Erklärung 1:1 dem entsprechen, was die Crew im UI sieht.
function TextIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="inline h-4 w-4 align-text-bottom text-primary" aria-hidden="true" />;
}

export const metadata = {
  title: "Über die Bordkassen-App · Bordkasse",
  description:
    "Was die Bordkassen-App kann: von der Crewverwaltung über die fünf Aufteilungsarten bis zur automatischen Datenlöschung.",
};

type Feature = {
  id: string;
  title: string;
  lead: React.ReactNode;
  body: React.ReactNode;
  screenshot: string;
  alt: string;
};

const features: Feature[] = [
  {
    id: "welcome",
    title: "Willkommen an Bord",
    lead: "Ein klarer Startbildschirm: anmelden oder zuerst nachlesen, wozu die App da ist.",
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
          aus dem Browser heraus auf den Startbildschirm legen. Danach
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
    lead: "Kein Passwort, keine Hürde: Du gibst deine E-Mail-Adresse an, bekommst einen Login-Link in dein Postfach und bist drin.",
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
    title: "Törnübersicht",
    lead: "Alle deine Törns auf einen Blick, laufende wie archivierte.",
    body: (
      <>
        <p>
          Jede Kachel zeigt Reisedaten, Schiffsnamen und wie viele Personen
          mitsegeln. Wer einen <strong>Skipper</strong>- oder
          <strong> Admin</strong>-Zugang hat, sieht oben einen Button, um
          einen neuen Törn anzulegen. Crewmitglieder sehen nur die Törns,
          zu denen sie eingeladen wurden.
        </p>
      </>
    ),
    screenshot: "/about/03-trips.webp",
    alt: "Liste aller eigenen Törns",
  },
  {
    id: "trip-overview",
    title: "Startseite des Törns",
    lead: "Pro Törn ein eigener Bereich: Schnellzugriff auf Buchungen, Bilanz, Anzahlungen und Schulden.",
    body: (
      <>
        <p>
          Die Navigationsleiste am unteren Bildschirmrand bleibt immer
          sichtbar, damit auch im Hafentrubel alle Bereiche schnell
          erreichbar sind. Der große Plus-Button unten rechts öffnet die
          Eingabemaske für eine neue Buchung in einem Schritt.
        </p>
        <p className="mt-2">
          Sobald der Törn vorbei ist, erscheint oben ein Hinweisbanner:
          „Kaution prüfen + Abrechnung verschicken“. Skipper und Admins
          können mit einem Klick allen Beteiligten eine E-Mail mit der
          fertigen Abrechnung schicken. Bei nachträglichen Änderungen
          erinnert die App, eine Update-Mail rauszuschicken. Und für
          Yachtanzahlungen verschickt sie 3 Tage vor jeder Frist
          selbstständig Erinnerungen.
        </p>
      </>
    ),
    screenshot: "/about/04-trip-overview.webp",
    alt: "Übersicht eines anstehenden Törns mit Crewzähler, Schnellzugriff-Kacheln und Navigationsleiste",
  },
  {
    id: "toern-ueberblick",
    title: "Törnfortschritt in fünf Phasen",
    lead: "Eine Fortschrittskarte führt den Skipper durch den ganzen Törn, von der Vorbereitung bis zur fertigen Abrechnung.",
    body: (
      <>
        <p>
          Auf der Startseite des Törns zeigt die App eine Checkliste mit fünf Phasen
          (Vorbereitung, Anzahlung, während des Törns, Abrechnung, Abschluss).
          Die Häkchen setzen sich <strong>automatisch</strong> aus dem echten
          Stand: Crew eingeladen, erste Ausgabe erfasst, Abrechnung verschickt …
          Nichts muss von Hand abgehakt werden.
        </p>
        <p className="mt-2">
          Die aktuelle Phase ist aufgeklappt, kommende Schritte stehen gedämpft
          darunter; die Karte lässt sich jederzeit einklappen. Sie ist dem
          Skipper, den Co-Skippern und Admins vorbehalten. Die Crew sieht sie
          nicht.
        </p>
      </>
    ),
    screenshot: "/about/18-toern-fortschritt.webp",
    alt: "Törnübersicht mit der Fortschrittskarte „Dein Törn im Überblick“ und den fünf Phasen",
  },
  {
    id: "buchungen",
    title: "Buchungsliste",
    lead: "Alle Ausgaben und Gutschriften, nach Datum sortiert: Wer hat was bezahlt, mit welcher Aufteilung. So bleibt für alle nachvollziehbar, wohin das Geld geht.",
    body: (
      <>
        <p>
          Pro Eintrag siehst du Beschreibung, Betrag, wer bezahlt hat,
          welche Aufteilung gewählt wurde und welche Kategorie. Gutschriften
          sind farblich abgesetzt. Ein Tipper öffnet die Bearbeitung. Ändern
          darf, wer die Buchung angelegt hat, sowie Skipper und Admin.
        </p>
      </>
    ),
    screenshot: "/about/05-buchungen.webp",
    alt: "Buchungsliste eines laufenden Törns",
  },
  {
    id: "buchung-neu",
    title: "Ausgaben eintragen: fünf Aufteilungsarten",
    lead: "Jede Ausgabe lässt sich auf fünf Arten verteilen: Gleichmäßig, nur An-Bord-Anwesende, Zeitanteilig, Individuell oder Pro Person.",
    body: (
      <>
        <p>
          „<strong>Pro Person</strong>“ ist für Restaurants, in denen von
          einer Person für alle gezahlt wird, jedoch jede:r die eigene
          Bestellung zahlt. Du musst die Rechnungssumme nicht extra
          eingeben. Und vor allem: kein Kopfrechnen, keine Nebenrechnungen,
          kein Taschenrechner. Du tippst die Einzelposten
          pro Person einfach vom Beleg ab, z. B.{" "}
          <em>Getränke 3,50 €</em> und <em>Essen 13 €</em> für Anna, dann{" "}
          <em>Getränke 4 €</em> und <em>Essen 15,80 €</em> für Ben. Die
          App summiert das automatisch zum Gesamtbetrag jeder Person
          und zur Rechnungssumme. Das <strong>Trinkgeld</strong> kommt in
          ein eigenes Feld und wird anschließend auf alle Beteiligten
          umgelegt (wahlweise im Verhältnis zum jeweiligen Rechnungsbetrag
          oder gleichmäßig pro Kopf).
        </p>
        <p className="mt-2">
          Zusätzlich gibt es einen <strong>Alkoholanteil</strong> (unter
          „Erweitert“): Den Alkoholteil eines Belegs zahlen nur diejenigen,
          die als mittrinkend eingetragen sind. Der Rest läuft nach der
          gewählten Aufteilung. Das Komma im Betrag versteht die App
          selbstverständlich auf Deutsch. Und „Bezahlt von“ ist gleich mit
          dir vorbelegt, weil meist die erfassende Person zahlt (mit einem
          Tipp umstellbar).
        </p>
      </>
    ),
    screenshot: "/about/06-buchung-neu.webp",
    alt: "Neue Buchung anlegen mit Aufteilungsauswahl",
  },
  {
    id: "bilanz",
    title: "Bilanz",
    lead: "Wer hat insgesamt mehr gezahlt als verbraucht, wer weniger? Der Saldo wird laufend aus allen Buchungen berechnet.",
    body: (
      <>
        <p>
          Grün heißt: bekommt Geld zurück. Rot heißt: zahlt nach. Die Summe
          aller Salden ergibt immer null. Alle Crewmitglieder können die
          Bilanz einsehen: Transparenz für die ganze Crew.
        </p>
      </>
    ),
    screenshot: "/about/07-bilanz.webp",
    alt: "Bilanzübersicht mit Saldo pro Person",
  },
  {
    id: "schulden",
    title: "Schulden: möglichst wenige Überweisungen",
    lead: "Statt dass jeder an jeden zahlt, rechnet die App den Zahlungsplan auf die kleinstmögliche Anzahl Überweisungen herunter.",
    body: (
      <>
        <p>
          Wer noch Geld bekommt und wer noch nachzahlen muss, wird so
          zusammengefasst, dass die Crew mit wenigen Überweisungen
          fertig ist. Jede Zahlung kann mit einem Häkchen als „bezahlt“
          markiert werden. Alle in der Crew sehen den Stand sofort. Das
          Häkchen setzen dürfen nur die beiden direkt Beteiligten
          (wer zahlt und wer das Geld bekommt) sowie der Skipper oder Admin.
        </p>
        <p className="mt-2">
          Sobald ein Häkchen gesetzt wird, gehen automatisch
          Bestätigungs-Mails an die zahlende und die empfangende Person. Wenn ein Admin
          stellvertretend abhakt, bekommen Skipper und die vorstreckende Person
          zusätzlich eine Info-Mail, damit niemand übersieht, dass
          jemand anderes in diesem Törnkontext geklickt hat.
        </p>
      </>
    ),
    screenshot: "/about/08-schulden.webp",
    alt: "Schuldenübersicht mit Bezahlt-Häkchen",
  },
  {
    id: "statistik",
    title: "Auswertung der Ausgaben",
    lead: "Wie viel haben wir für Sprit ausgegeben? Welche Kategorie war am teuersten? Alles pro Törn aufgeschlüsselt.",
    body: (
      <>
        <p>
          Alle Crewmitglieder können die Statistik einsehen. Sie bleibt
          auch nach der automatischen Datenlöschung in anonymisierter Form
          erhalten: also Beträge, Kategorien und Tage, aber ohne
          Personenbezug. So kannst du auch Jahre später noch nachsehen,
          wie ein vergangener Törn finanziell aussah.
        </p>
      </>
    ),
    screenshot: "/about/09-statistik.webp",
    alt: "Statistikbereich mit Auswertung nach Kategorie",
  },
  {
    id: "crew",
    title: "Crew einladen und verwalten",
    lead: "Skipper und Admins laden die Crew per E-Mail ein oder tragen Personen ohne eigenen Login als Platzhalter ein.",
    body: (
      <>
        <p>
          Wenn jemand keinen eigenen Login möchte (Eltern, Kinder, Freunde
          ohne Lust auf Apps), legt der Skipper einfach einen Platzhalter
          an. Pro Person werden der Anwesenheitszeitraum (An Bord ab/bis),
          ein Häkchen für „trinkt Alkohol“ und optional eine Notiz
          hinterlegt. Co-Skipper können beim Verwalten helfen. Alle
          Crewmitglieder sehen die Liste, bearbeiten dürfen aber nur die
          eigenen Daten. Der Rest bleibt dem Skipper vorbehalten.
        </p>
      </>
    ),
    screenshot: "/about/10-crew.webp",
    alt: "Crewverwaltung mit Anwesenheitszeiten und Alkoholhäkchen",
  },
  {
    id: "kategorien",
    title: "Ausgaben übersichtlich einordnen",
    lead: (
      <>
        Lebensmittel <TextIcon icon={ShoppingCart} />, Sprit{" "}
        <TextIcon icon={Fuel} />, Yacht <TextIcon icon={Sailboat} />, Hafen{" "}
        <TextIcon icon={Anchor} />: pro Törn frei wählbar aus einem Satz
        vorgefertigter Symbole.
      </>
    ),
    body: (
      <>
        <p>
          Eine Grundauswahl ist voreingestellt. Skipper und Admins können
          Kategorien umbenennen, löschen oder neue hinzufügen. Jede
          Kategorie taucht später in der Statistik wieder auf.
        </p>
      </>
    ),
    screenshot: "/about/11-kategorien.webp",
    alt: "Kategorienverwaltung mit Symbolauswahl",
  },
  {
    id: "gutschrift",
    title: "Gutschriften",
    lead: "Wenn jemand außerhalb der Bordkasse gezahlt hat, etwa die Yachtvorauszahlung, wird das als Gutschrift verrechnet.",
    body: (
      <>
        <p>
          Eine Gutschrift kann direkt von Person zu Person laufen oder
          „An Alle“ gehen: Letzteres, wenn jemand vorab für die ganze Crew
          bezahlt hat. Damit nichts versehentlich doppelt verbucht wird,
          dürfen Gutschriften nur Skipper und Admins eintragen.
        </p>
      </>
    ),
    screenshot: "/about/12-gutschrift.webp",
    alt: "Gutschriftformular mit „Zahlt“ und „Empfängt“ Auswahl",
  },
  {
    id: "anzahlung-setup",
    title: "Yachtanzahlung: Plan einrichten",
    lead: "Wenn der Skipper Monate vor dem Törn die Charteranzahlung an die Agentur leistet, hilft die App, das Geld bei der Crew einzusammeln.",
    body: (
      <>
        <p>
          Im Anzahlungs-Wizard wird zuerst festgelegt, wie sich die
          Gesamtsumme auf die Crew verteilt: <strong>gleichmäßig</strong>,{" "}
          <strong>zeitanteilig</strong>, <strong>individuell</strong>{" "}
          oder nach <strong>Kojen</strong> (jede Kabine bekommt einen
          eigenen Preis, Crewmitglieder werden den Kabinen zugewiesen).
          Wer das Geld vorstreckt, ist meistens der Skipper, kann aber
          auch jemand anderes sein. An diese vorstreckende Person zahlt
          die Crew dann.
        </p>
        <p className="mt-2">
          Im zweiten Schritt werden die <strong>Tranchen</strong> definiert,
          typischerweise eine erste Anzahlung von 30 % Monate vorab und
          70 % Endzahlung kurz vor dem Törn. Die App benennt sie automatisch
          durch (1. Anzahlung, 2. Anzahlung … Endzahlung); die Summe muss
          100 % ergeben.
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
    title: "Wer hat welche Anzahlung gezahlt?",
    lead: "Eine Person-mal-Tranche-Tabelle mit Statussymbolen: offen, teilweise, bezahlt, überfällig, gemeldet aber unbestätigt.",
    body: (
      <>
        <p>
          Ein Klick auf eine Zelle öffnet ein Modal zum Erfassen einer
          Zahlung. Überschuss kann automatisch auf die nächste Tranche
          übertragen werden. Über die <strong>Glocke</strong>{" "}
          <TextIcon icon={Bell} /> in der Zeile schickt der Skipper eine
          persönliche Erinnerungs-Mail mit Wero-ID und Verwendungszweck;
          über die <strong>Sprechblase</strong>{" "}
          <TextIcon icon={MessageCircle} /> bekommt er einen
          WhatsApp-Vorschlagstext zum Kopieren.
        </p>
        <p className="mt-2">
          Ein Fortschrittsbalken oben zeigt auf einen Blick, wie viel
          schon eingegangen ist. Auf dem Smartphone erscheint jede Person
          als eigene Karte, ganz ohne horizontales Wischen; am größeren
          Bildschirm bleibt die Tabelle für den Quervergleich.
        </p>
        <p className="mt-2">
          Daneben sieht die vorstreckende Person eine Übersicht, was sie noch an den
          Charteranbieter überweisen muss, basierend auf dem, was die
          Crew schon bei ihr eingezahlt hat. 3 Tage vor jeder
          Charterfrist verschickt die App diese Übersicht zusätzlich
          per Mail; 3 Tage vor der Crewfrist gehen automatisch
          Erinnerungen an alle Crewmitglieder mit offenem Betrag.
        </p>
      </>
    ),
    screenshot: "/about/16-anzahlung-matrix.webp",
    alt: "Anzahlungsmatrix als Karten-Ansicht mit Fortschrittsbalken, Charterhinweis und Pending-Bestätigung",
  },
  {
    id: "anzahlung-crew-self",
    title: "Crew meldet selbst",
    lead: "Crewmitglieder sehen ihre eigenen Anzahlungen und können mit einem Klick melden, dass sie überwiesen haben.",
    body: (
      <>
        <p>
          Statt dass der Skipper jeden Eingang manuell abhaken muss, kann
          die Crew selbst „Ich habe gezahlt“ drücken. Die vorstreckende
          Person bekommt eine Mail und sieht in der Matrix ein gelbes
          ⏳-Symbol. Sie bestätigt mit <TextIcon icon={Check} />, sobald das
          Geld auf ihrem Konto ist, oder lehnt mit <TextIcon icon={X} /> ab.
          Erst nach Bestätigung zählt die
          Zahlung in der Bilanz.
        </p>
        <p className="mt-2">
          Sobald die vorstreckende Person bestätigt oder ablehnt, bekommt das
          Crewmitglied eine kurze Info-Mail. Bei einer Ablehnung
          enthält die Mail einen Hinweis, mit dem Skipper Rücksprache zu
          halten.
        </p>
        <p className="mt-2">
          Anzahlungen tauchen für Crewmitglieder nur in der Navigation
          auf, solange sie selbst noch etwas offen haben. Ist alles
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
    lead: "Auf der Yacht ist Empfang Glückssache. Die App funktioniert trotzdem.",
    body: (
      <>
        <p>
          Buchungen, die du ohne Internet eingibst, werden auf dem Gerät
          zwischengespeichert und automatisch übertragen, sobald wieder
          Empfang da ist. Ein dezenter Hinweis oben am Bildschirm zeigt,
          dass du gerade offline arbeitest.
        </p>
      </>
    ),
    screenshot: "/about/13-offline.webp",
    alt: "Buchungsliste mit Offline-Hinweis oben",
  },
  {
    id: "dsgvo",
    title: "Automatische Datenlöschung",
    lead: "30 Tage nach Törnende werden alle personenbezogenen Daten automatisch entfernt.",
    body: (
      <>
        <p>
          Crewliste, Buchungen mit Personenbezug, Gutschriften, die
          Änderungshistorie: Alles wird automatisch gelöscht. Was bleibt,
          ist eine anonymisierte Statistik ohne Personenbezug. Die Details
          stehen in der{" "}
          <Link href="/datenschutz" className="underline">
            Datenschutzerklärung
          </Link>
          .
        </p>
      </>
    ),
    screenshot: "/about/14-dsgvo.webp",
    alt: "Datenschutzabschnitt zur 30-Tage-Löschung nach Törnende",
  },
];

// Anzeige-Reihenfolge nach typischem Törn-Ablauf, in 5 Phasen gruppiert.
// Jede Phase bekommt eine Sektion mit kurzem Lead und einer Karten-Liste.
type PhaseId =
  | "loslegen"
  | "vor-dem-toern"
  | "waehrend-des-toerns"
  | "abrechnung"
  | "nach-dem-toern";

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
    featureIds: ["welcome", "anmelden", "toerns", "trip-overview", "toern-ueberblick"],
  },
  {
    id: "vor-dem-toern",
    Icon: Anchor,
    title: "Vor dem Törn",
    lead: "Crew einladen, Kategorien festlegen, optional Yachtanzahlung mit Tranchen.",
    featureIds: ["crew", "kategorien", "anzahlung-setup", "anzahlung-matrix", "anzahlung-crew-self"],
  },
  {
    id: "waehrend-des-toerns",
    Icon: Sailboat,
    title: "Während des Törns",
    lead: "Ausgaben und Gutschriften erfassen, auch ohne Internet.",
    featureIds: ["buchungen", "buchung-neu", "gutschrift", "offline"],
  },
  {
    id: "abrechnung",
    Icon: Wallet,
    title: "Abrechnung",
    lead: "Wer bekommt Geld zurück, wer zahlt nach? Die App rechnet den Ausgleich auf möglichst wenige Überweisungen herunter, abgehakt wird gemeinsam.",
    featureIds: ["bilanz", "schulden"],
  },
  {
    id: "nach-dem-toern",
    Icon: History,
    title: "Nach dem Törn",
    lead: "Rückblick auf die Ausgaben. Personenbezogene Daten verschwinden 30 Tage nach Törnende automatisch.",
    featureIds: ["statistik", "dsgvo"],
  },
];

function featureById(id: string): Feature {
  const found = features.find((f) => f.id === id);
  if (!found) throw new Error(`Feature mit id="${id}" fehlt in features[].`);
  return found;
}

// Rollen-Zuordnung pro Feature (steuert Badge + Filter im Explorer).
// Nicht gelistete Features sind "alle" — von Skipper UND Crew genutzt.
const SKIPPER_ONLY = new Set<string>([
  "toern-ueberblick",
  "crew",
  "kategorien",
  "gutschrift",
  "anzahlung-setup",
  "anzahlung-matrix",
]);
const CREW_ONLY = new Set<string>(["anzahlung-crew-self"]);

function roleFor(id: string): FeatureRole {
  if (SKIPPER_ONLY.has(id)) return "skipper";
  if (CREW_ONLY.has(id)) return "crew";
  return "alle";
}

export default function AboutPage() {
  const phasesData: ExplorerPhase[] = PHASES.map((phase) => ({
    id: phase.id,
    title: phase.title,
    lead: phase.lead,
    icon: <phase.Icon className="h-5 w-5" aria-hidden="true" />,
    features: phase.featureIds.map((id) => ({
      ...featureById(id),
      role: roleFor(id),
    })),
  }));

  // Neutraler Rahmungs-Einzeiler über den Tabs — erklärt die 5-Phasen-Logik
  // der Seite, ohne ein rollenspezifisches Feature in den Vordergrund zu
  // stellen. Die Törn-Fortschritt-Karte selbst sitzt als ⚓-Feature in der
  // Phase „Loslegen".
  const explorerIntro = (
    <p className="mb-6 text-sm text-ink-soft">
      Die App begleitet jeden Törn in fünf Phasen. Tipp dich durch die Tabs,
      um zu sehen, was in jeder passiert.
    </p>
  );

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      {/* Alle Inhalte teilen eine gemeinsame linke Kante; die Textspalte
          bricht nur früher um (max-w-3xl, ~65 Zeichen), der Explorer nutzt
          die volle Breite. Bewusst KEIN mx-auto — das erzeugte sonst einen
          Versatz der Textspalte gegenüber der Tab-Leiste darunter. */}
      <div className="max-w-3xl">
        <div className="mb-6">
          <Link href="/" className="text-sm text-ink-soft hover:text-primary">
            ← Übersicht
          </Link>
        </div>

        <h1 className="text-3xl font-bold text-primary">
          Wer schuldet am Ende wem wie viel? Diese App rechnet&rsquo;s aus.
        </h1>
        <p className="mt-3 text-base leading-relaxed text-ink-soft">
          Faire Aufteilung gemeinsamer Kosten auf Segeltörns, auch wenn die
          Crew wechselt, manche keinen Alkohol trinken und einzelne erst
          später dazustoßen oder früher von Bord gehen.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          Die App ist gedacht für Skipper und ihre Crews, die nicht jede
          Ausgabe von Hand in eine Tabelle tippen wollen. Sie läuft auf dem
          Smartphone, das Anmelden geht ohne Passwort (Login-Link per E-Mail),
          und sie rechnet faire Salden auch dann, wenn Crewmitglieder zu
          unterschiedlichen Zeiten an und von Bord gehen.
        </p>
      </div>

      <AboutExplorer phases={phasesData} intro={explorerIntro} />

      {/* Linksbündig auf derselben Kante wie Hero + Explorer. */}
      <div className="max-w-3xl">
      <section className="mt-16 rounded-lg border border-rule bg-paper-soft p-6">
        <h2 className="text-lg font-semibold text-primary">
          Was die App <em>nicht</em> ist
        </h2>
        <ul className="mt-3 ml-5 list-disc space-y-1 text-sm text-ink-soft">
          <li>
            Kein kommerzielles Produkt, sondern ein privates Werkzeug für
            eigene Törns.
          </li>
          <li>Keine Tracking-, Analyse- oder Werbecookies.</li>
          <li>
            Keine Datenweitergabe an Dritte außerhalb der nötigen
            technischen Infrastruktur (siehe Datenschutz).
          </li>
        </ul>
      </section>
      </div>

      {/* Abschluss bewusst seitenmittig (konventioneller Closing-CTA). */}
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
        <span className="mx-2">·</span>
        <Link href="/kontakt" className="hover:text-primary">
          Kontakt
        </Link>
      </p>
    </main>
  );
}
