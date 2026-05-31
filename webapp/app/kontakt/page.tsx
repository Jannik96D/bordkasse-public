import Link from "next/link";

export const metadata = {
  title: "Kontakt · Bordkasse",
};

/**
 * Kontakt-Seite (bewusst KEIN formales Impressum).
 *
 * Die Bordkasse ist eine private, nicht-kommerzielle, invite-only App ohne
 * Werbung/Gewinnerzielung — damit greift die Impressumspflicht nach § 5 DDG /
 * § 18 Abs. 2 MStV aller Voraussicht nach nicht (Ausnahme für ausschließlich
 * persönliche/familiäre Zwecke). Der/die Verantwortliche ist über die
 * Datenschutzerklärung identifizierbar; eine ladungsfähige Wohnanschrift wird
 * hier bewusst NICHT veröffentlicht.
 *
 * ⚠️ Sobald die App je kommerziell betrieben wird (Werbung, Gebühren, Verkauf),
 * wird ein vollständiges Impressum inkl. Anschrift Pflicht.
 */
export default function KontaktPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10">
      <div className="mb-6">
        <Link href="/" className="text-sm text-ink-soft hover:text-primary">
          ← Übersicht
        </Link>
      </div>

      <h1 className="text-2xl font-bold text-primary">Kontakt</h1>
      <p className="mt-1 text-sm text-ink-soft">Wer betreibt die Bordkasse?</p>

      <section className="prose mt-8 max-w-none space-y-6 text-sm leading-relaxed">
        <div>
          <h2 className="text-base font-semibold">Betreiber</h2>
          <p>
            Jannik Dieter, erreichbar unter{" "}
            <a href="mailto:bordkasse@dieter.ms" className="underline">
              bordkasse@dieter.ms
            </a>
            .
          </p>
        </div>

        <div>
          <h2 className="text-base font-semibold">Art des Angebots</h2>
          <p>
            Die Bordkasse ist eine private, nicht-kommerzielle Anwendung zur
            fairen Aufteilung gemeinsamer Kosten auf Segeltörns. Es werden keine
            Waren oder Dienstleistungen angeboten, es wird keine
            Gewinnerzielungsabsicht verfolgt und es wird keine Werbung geschaltet.
          </p>
        </div>

        <div>
          <p className="text-ink-soft">
            Hinweise zum Umgang mit personenbezogenen Daten findest du in der{" "}
            <Link href="/datenschutz" className="underline">
              Datenschutzerklärung
            </Link>
            .
          </p>
        </div>
      </section>
    </main>
  );
}
