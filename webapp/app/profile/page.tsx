import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { isAdmin } from "@/lib/auth/authz";
import { ProfileForm } from "./profile-form";
import { DeleteAccountBlock } from "./delete-account-block";
import { signOut } from "./actions";

export default async function ProfilePage() {
  const person = await getCurrentPerson();
  if (!person) redirect("/login");

  const admin = await isAdmin();

  return (
    <main className="mx-auto w-full max-w-md px-6 py-10">
      <div className="mb-6">
        <Link href="/" className="text-sm text-ink-soft hover:text-primary">
          ← Übersicht
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-bold text-primary">Mein Profil</h1>
        {admin && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-navy-light px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary"
            title="Du bist Admin und darfst neue Törns anlegen."
          >
            <ShieldCheck className="h-3 w-3" />
            Admin
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-ink-soft">
        {admin
          ? "Du darfst Törns anlegen und verwalten."
          : "Wird in Bilanz, Schulden und Crew-Listen verwendet."}
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

      <DeleteAccountBlock />

      <p className="mt-8 text-center text-xs text-ink-soft">
        <Link href="/datenschutz" className="hover:text-primary">Datenschutz</Link>
      </p>
    </main>
  );
}
