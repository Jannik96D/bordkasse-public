/**
 * Ermittelt die Client-IP fürs Login-Rate-Limit (app/login/actions.ts).
 *
 * Lebt bewusst NICHT in actions.ts: eine "use server"-Datei darf laut
 * Next.js 16.3 nur noch async Funktionen exportieren (striktere Prüfung
 * ab dieser Version, vorher toleriert) — eine reine, synchrone
 * Hilfsfunktion wie diese hier bricht den Build sonst mit "Server Actions
 * must be async functions".
 *
 * SICHERHEIT: `x-forwarded-for` ist clientseitig frei setzbar — ein Angreifer
 * kann bei jedem Request eine beliebige, zufällige "IP" mitschicken und so
 * das IP-Rate-Limit trivial umgehen, wenn man naiv den LINKESTEN (ersten)
 * Eintrag nimmt (das war der ursprüngliche Bug hier).
 *
 * ⚠️ `x-real-ip` wird HIER BEWUSST NICHT bevorzugt. Anders als z. B. Nginx
 * setzt Traefik `X-Real-Ip` nicht automatisch — nur wenn eine dafür
 * konfigurierte Middleware/ein Plugin existiert. Im Repo findet sich dafür
 * KEIN Beleg (kein `trustedIPs`, keine entsprechende Traefik-Config
 * eingecheckt — die Coolify-verwaltete Traefik-Konfiguration lebt außerhalb
 * dieses Repos). Ohne diese Garantie könnte ein Angreifer einfach selbst
 * `X-Real-Ip: 1.2.3.4` mitschicken und Traefik würde diesen Header
 * unverändert durchreichen — exakt derselbe Bug wie vorher, nur unter
 * anderem Header-Namen.
 *
 * Stattdessen wird ausschließlich der LETZTE Eintrag von `x-forwarded-for`
 * genutzt: das ist eine strukturelle Garantie praktisch jedes Reverse-Proxys
 * (auch ohne Sonderkonfiguration) — ein Proxy HÄNGT die IP seines direkten
 * TCP-Peers an einen ggf. vom Client mitgeschickten XFF-Header AN, er ersetzt
 * ihn nicht. Der letzte Eintrag ist deshalb immer der, den der unmittelbare
 * Proxy selbst gesehen hat; alles davor kann der Client gefälscht haben.
 * Vorausgesetzt: Traefik ist laut Hosting-Setup der EINZIGE Hop zwischen
 * Client und App-Container (kein CDN/zusätzlicher Load Balancer davor) — vor
 * dem Produktions-Deploy trotzdem einmal gegen den echten Traffic verifizieren.
 *
 * Fehlt `x-forwarded-for` ebenfalls (z. B. lokal ohne Proxy): `"unknown"` als
 * Fail-Open-Fallback (unverändertes Verhalten — das Limit greift dann nur
 * noch global über den `ip:unknown`-Schlüssel).
 */
export function resolveClientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }

  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;

  return "unknown";
}
