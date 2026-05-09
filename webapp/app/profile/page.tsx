import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { ProfileForm } from "./profile-form";
import { signOut } from "./actions";

export default async function ProfilePage() {
  const person = await getCurrentPerson();
  if (!person) redirect("/login");

  return (
    <main className="mx-auto w-full max-w-md px-6 py-10">
      <div className="mb-6">
        <Link href="/" className="text-sm text-ink-soft hover:text-primary">
          ← Übersicht
        </Link>
      </div>

      <h1 className="text-2xl font-bold text-primary">Mein Profil</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Wird in Bilanz, Schulden und Crew-Listen verwendet.
      </p>

      <div className="mt-8">
        <ProfileForm
          initialDisplayName={person.display_name}
          initialIsAlcoholic={person.is_alcoholic}
          email={person.email ?? ""}
        />
      </div>

      <div className="mt-12 border-t border-rule pt-6">
        <form action={signOut}>
          <button
            type="submit"
            className="text-sm font-medium text-ink-soft hover:text-danger"
          >
            Abmelden
          </button>
        </form>
      </div>

      <p className="mt-8 text-center text-xs text-ink-soft">
        <Link href="/datenschutz" className="hover:text-primary">Datenschutz</Link>
      </p>
    </main>
  );
}
