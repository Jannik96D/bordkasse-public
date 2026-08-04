import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Refresht die Supabase-Auth-Session bei jedem Request und schützt private
 * Routen. Läuft VOR jeder Server-Komponenten-Render-Phase.
 *
 * Hinweis: In Next.js 16 heißt diese Konvention `proxy` (vormals
 * `middleware` — seit 16.2 deprecated). Datei + Export-Name entsprechend
 * `proxy`; die `config.matcher`-Logik bleibt unverändert.
 */

const PUBLIC_ROUTES = new Set([
  "/login",
  "/auth/callback",
  "/auth/confirm",
  "/auth/verify",
  "/datenschutz",
  "/kontakt",
  "/about",
]);

export async function proxy(request: NextRequest) {
  // Cron-Endpunkte (Vercel Cron, kein Session-Cookie, nur `Authorization:
  // Bearer <CRON_SECRET>`) laufen NICHT durch die Session-Middleware — sonst
  // landet jeder Aufruf mangels User in einem 307-Redirect auf /login. Cron-
  // Jobs folgen keinen Redirects und Vercel loggt Redirect-Antworten nicht,
  // weshalb der Ausfall unbemerkt bliebe (Code-Review 2026-08, Fund 2). Die
  // Route-Handler unter app/api/cron/* sind selbst fail-closed via
  // verifyCronAuth (lib/auth/cron-auth.ts) geschützt — dieser Bypass entzieht
  // ihnen also keinen Schutz, er lässt sie nur den Proxy überhaupt erreichen.
  if (request.nextUrl.pathname.startsWith("/api/cron/")) {
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Wichtig: getUser() refresht die Session, falls JWT abgelaufen.
  const { data: { user } } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_ROUTES.has(pathname) || pathname === "/";

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", pathname);
    return NextResponse.redirect(url);
  }

  if (user && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    // Alles außer Next.js-Internals und statischen Assets. robots.txt,
    // manifest.json, sw.js und offline.html sind öffentliche Dateien aus
    // public/ und müssen OHNE Auth erreichbar sein — sonst 307 → /login:
    // Crawler lesen robots.txt nicht, PWA-Manifest + Service Worker laden auf
    // den öffentlichen Seiten nicht, und der SW würde statt der Offline-Seite
    // einen Login-Redirect cachen.
    //
    // `email/magic-link.html` ebenso: selbst gehostetes Supabase-Auth
    // (GoTrue) holt das gebrandete Template per HTTP-GET von dort — als
    // unauthentifizierter Client ohne Session-Cookie. Fehlt die Ausnahme,
    // bekommt GoTrue einen 307 auf /login, hält das für ein ungültiges
    // Template und fällt STILL auf sein Default zurück: die Login-Mails
    // kämen unbrandet an, ohne Fehler im Log. Die Datei enthält nur Layout
    // + Go-Template-Platzhalter, keine Geheimnisse.
    //
    // Bewusst der exakte Dateiname statt `email/`: ein Präfix hätte jede
    // künftige Route unter /email/* automatisch unauthentifiziert gemacht —
    // eine Falle, die beim Anlegen der Route niemand hier vermuten würde.
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|manifest.json|sw.js|offline.html|email/magic-link\\.html|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
