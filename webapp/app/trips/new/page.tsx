import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth/authz";
import { getCurrentPerson } from "@/lib/auth/get-current-person";
import { NewTripForm } from "./new-trip-form";

/**
 * Server-Side-Guard: Admins (ADMIN_EMAILS) ODER Personen, die ein Admin
 * über persons.can_create_trips freigeschaltet hat (Migration 0045),
 * dürfen die Form erreichen. Alle anderen werden zur Übersicht zurückgeschickt.
 */
export default async function NewTripPage() {
  const [admin, person] = await Promise.all([isAdmin(), getCurrentPerson()]);
  if (!admin && !person?.can_create_trips) {
    redirect("/");
  }
  return <NewTripForm isAdmin={admin} />;
}
