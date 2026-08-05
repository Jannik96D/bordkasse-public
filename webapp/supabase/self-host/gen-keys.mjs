#!/usr/bin/env node
/**
 * Erzeugt alle Secrets für den selbst gehosteten Supabase-Stack.
 *
 *   node supabase/self-host/gen-keys.mjs
 *
 * Ausgabe ist ein fertiger .env-Block zum Einfügen in die Coolify-Env-
 * Verwaltung. Läuft komplett offline mit Node-Bordmitteln — bewusst KEIN
 * Web-Generator: die üblichen „JWT-Key-Generatoren" im Netz bekommen dein
 * JWT_SECRET zu sehen, und wer das hat, kann sich gegenüber der Datenbank
 * als `service_role` ausgeben und an jeder RLS-Policy vorbeilesen.
 *
 * Die beiden API-Keys sind HS256-JWTs, signiert mit JWT_SECRET. Sie müssen
 * aus DEMSELBEN Secret stammen wie das, das in den Stack geht — sonst
 * antwortet die API auf alles mit 401.
 *
 * ⚠️ Die Ausgabe enthält echte Geheimnisse: nicht in Chats, Tickets oder
 * Logs kopieren, nicht ins Repo committen.
 */
import { createHmac, randomBytes } from "node:crypto";

/** base64url ohne Padding — JWT-Standard (RFC 7515). */
function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signJwt(payload, secret) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = createHmac("sha256", secret).update(data).digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${data}.${sig}`;
}

// Zeichensatz bewusst alphanumerisch: diese Werte landen teils in
// Postgres-Verbindungs-URLs (postgres://user:pass@host/db), wo +, / oder @
// URL-kodiert werden müssten — eine klassische Fehlerquelle beim Aufsetzen.
//
// Rejection-Sampling statt `b % chars.length`: 256 ist nicht durch 62
// teilbar, ein einfaches Modulo würde die ersten Zeichen des Alphabets
// leicht überrepräsentieren (bei der hier verwendeten Länge praktisch
// irrelevant, aber sauberes Sampling ist genauso billig).
function alnum(count) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const limit = chars.length * Math.floor(256 / chars.length); // 248
  let out = "";
  while (out.length < count) {
    const buf = randomBytes(count - out.length);
    for (const b of buf) {
      if (b < limit) out += chars[b % chars.length];
    }
  }
  return out;
}

const jwtSecret = alnum(48);
const now = Math.floor(Date.now() / 1000);
// 10 Jahre. Diese Keys sind langlebige API-Keys, keine User-Sessions.
const exp = now + 60 * 60 * 24 * 365 * 10;

const anonKey = signJwt({ role: "anon", iss: "supabase", iat: now, exp }, jwtSecret);
const serviceKey = signJwt({ role: "service_role", iss: "supabase", iat: now, exp }, jwtSecret);

console.log(`# ── Erzeugt am ${new Date().toISOString()} ────────────────────────
# Diese Werte in die Coolify-Env-Verwaltung des Supabase-Stacks eintragen.
# NICHT committen. Einmal erzeugen und behalten — ein Wechsel von JWT_SECRET
# entwertet ANON_KEY und SERVICE_ROLE_KEY und loggt alle Crewmitglieder aus.

POSTGRES_PASSWORD=${alnum(36)}
JWT_SECRET=${jwtSecret}
ANON_KEY=${anonKey}
SERVICE_ROLE_KEY=${serviceKey}
SECRET_KEY_BASE=${alnum(64)}
REALTIME_DB_ENC_KEY=${alnum(16)}
PG_META_CRYPTO_KEY=${randomBytes(16).toString("hex")}
DASHBOARD_USERNAME=bordkasse
DASHBOARD_PASSWORD=${alnum(32)}

# ── Für die App (Coolify-Env des App-Containers bzw. Vercel) ─────────────
# NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY von oben
# SUPABASE_SERVICE_ROLE_KEY     = SERVICE_ROLE_KEY von oben
`);
