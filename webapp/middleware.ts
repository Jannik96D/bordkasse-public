import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Refresht die Supabase-Auth-Session bei jedem Request und schützt private
 * Routen. Läuft VOR jeder Server-Komponenten-Render-Phase.
 *
 * Hinweis: Next.js 16 hat das in "proxy" umbenannt (deprecation-Warnung
 * im Log). Wir bleiben in v0.1 bei `middleware.ts` — Migration auf
 * `proxy.ts` sobald sich die Next.js-16-Convention stabilisiert hat.
 */

const PUBLIC_ROUTES = new Set([
  "/login",
  "/auth/callback",
  "/auth/confirm",
  "/auth/verify",
  "/datenschutz",
]);

export async function middleware(request: NextRequest) {
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
    // Alles außer Next.js-Internals und statischen Assets
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
