import Image from "next/image";
import Link from "next/link";

/**
 * Markenkonforme 404-Seite. Wird u. a. ausgelöst, wenn ein Törn nicht
 * existiert oder der User keinen Zugriff darauf hat (RLS liefert 0 Rows →
 * notFound() im Trip-Layout).
 */
export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm space-y-6 text-center">
        <Image
          src="/logo.png"
          alt="Bordkasse"
          width={120}
          height={92}
          priority
          className="mx-auto h-auto w-24 opacity-80"
        />
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-primary">Nicht gefunden</h1>
          <p className="text-sm text-ink-soft">
            Diese Seite gibt es nicht — oder dieser Törn ist für dich nicht
            freigegeben.
          </p>
        </div>
        <Link
          href="/"
          className="inline-block w-full rounded-md bg-primary px-4 py-3 font-medium text-paper hover:bg-navy-dark focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          Zur Törn-Übersicht
        </Link>
      </div>
    </main>
  );
}
