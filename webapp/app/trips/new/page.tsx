import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth/authz";
import { NewTripForm } from "./new-trip-form";

/**
 * Server-Side-Guard: nur Mails aus ADMIN_EMAILS dürfen die Form erreichen.
 * Nicht-Admins werden zur Übersicht zurückgeschickt.
 */
export default async function NewTripPage() {
  if (!(await isAdmin())) {
    redirect("/");
  }
  return <NewTripForm />;
}
