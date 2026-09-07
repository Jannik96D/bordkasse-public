"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "./actions";
import { cleanupOnLogout } from "@/lib/offline/logout-cleanup";
import { count as outboxCount } from "@/lib/offline/outbox";

/**
 * Ersetzt das bisherige reine `<form action={signOut}>` (Fund 5, PR 5), um vor
 * dem eigentlichen Abmelden Geräte-lokale Aufräumarbeiten anzustoßen:
 * Service-Worker-Caches, Fremdwährungs-Kurscache, eigenes Push-Abo — siehe
 * `lib/offline/logout-cleanup.ts`. Die IndexedDB-Outbox wird NIE automatisch
 * geleert; steht dort noch etwas, bleibt es unangetastet und der Nutzer
 * bekommt nach dem Abmelden einen Hinweis statt eines stillen Datenverlusts.
 */
export function SignOutButton() {
  const [pending, setPending] = useState(false);
  const router = useRouter();

  const handleSignOut = async () => {
    setPending(true);
    let hasPendingOutbox = false;
    try {
      hasPendingOutbox = (await outboxCount()) > 0;
    } catch {
      // Outbox nicht lesbar → im Zweifel keinen Hinweis unterdrücken, aber
      // auch keinen falschen anzeigen; einfach ohne Hinweis fortfahren.
    }
    await cleanupOnLogout();
    await signOut();
    router.push(hasPendingOutbox ? "/login?toast=logout-pending-outbox" : "/login");
  };

  return (
    <button
      type="button"
      onClick={handleSignOut}
      disabled={pending}
      className="text-sm font-medium text-ink-soft hover:text-danger disabled:opacity-50"
    >
      {pending ? "Abmelden …" : "Abmelden"}
    </button>
  );
}
