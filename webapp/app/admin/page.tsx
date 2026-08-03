import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth/authz";
import { createAdminClient } from "@/lib/supabase/admin";
import { AdminPermissionsList } from "./admin-permissions-list";

/**
 * Schlanke Admin-Seite: Personen-Liste mit Schalter „Darf Törns anlegen"
 * (Migration 0045). Nur Admin (ADMIN_EMAILS) — alle anderen zurück zur
 * Übersicht.
 */
export default async function AdminPage() {
  if (!(await isAdmin())) {
    redirect("/");
  }

  const supabase = createAdminClient();
  const [{ data: persons, error: personsError }, { data: privates, error: privatesError }] = await Promise.all([
    supabase
      .from("persons")
      .select("id, display_name, auth_user_id, can_create_trips")
      .order("display_name"),
    supabase.from("persons_private").select("person_id, email"),
  ]);
  if (personsError) console.error("[bordkasse:db]", personsError.message);
  if (privatesError) console.error("[bordkasse:db]", privatesError.message);
  const emailByPersonId = new Map((privates ?? []).map((pr) => [pr.person_id, pr.email]));

  const rows = (persons ?? []).map((p) => ({
    id: p.id,
    displayName: p.display_name,
    email: emailByPersonId.get(p.id) ?? null,
    hasLogin: !!p.auth_user_id,
    canCreateTrips: p.can_create_trips,
  }));

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-6">
        <Link href="/" className="text-sm text-ink-soft hover:text-primary">
          ← Übersicht
        </Link>
      </div>
      <h1 className="text-xl font-bold text-primary">Berechtigungen verwalten</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Schalte hier frei, welche Personen eigenständig neue Törns/Reisen anlegen dürfen —
        ohne sie zum globalen Admin zu machen.
      </p>
      {personsError && (
        <p className="mt-4 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger" role="alert">
          Personen konnten nicht geladen werden. Bitte Seite neu laden.
        </p>
      )}
      <AdminPermissionsList persons={rows} />
    </main>
  );
}
