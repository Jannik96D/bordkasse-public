#!/usr/bin/env node
// ── Akzeptanz-Probe Kong-Allowlist (Sicherheitsrunde 2026-11, Slice 2) ──────
//
// ⚠️ NUR gegen einen LOKALEN Test-Stack fahren, NIE gegen Produktion: die
// Probe legt Konten an, löst Mails aus, ändert Passwörter und schickt 120
// OTP-Anfragen.
//
// Lokaler Stack (Beispiel, Ports nur an 127.0.0.1):
//   docker-compose -p bordkasse-lab -f docker-compose.yml -f <override.yml> \
//     --env-file <lab.env> up -d --wait db auth rest kong
//   (override.yml veröffentlicht kong:8000 als 127.0.0.1:18000; lab.env aus
//   gen-keys.mjs + .env.example, SMTP auf einen Mailpit ohne Auth)
//
// Aufruf:  node probe-auth-allowlist.mjs <pfad/zu/lab.env> [http://127.0.0.1:18000]
// Gibt nur Statuscodes und Ja/Nein aus, keine Tokens. Erwartung mit Fix:
// alles außer verify/jwks/callback/authorize, GET /user, POST /logout und
// grant_type=refresh_token → 403 für den anon-Key; Service-Role-Key → voller
// Zugriff. Ergebnis ohne/mit Fix: siehe PR #… bzw. docs/self-hosting.md.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const env = Object.fromEntries(
  readFileSync(process.argv[2] ?? "lab.env", "utf8")
    .split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const ANON = env.ANON_KEY, SVC = env.SERVICE_ROLE_KEY;
const B = process.argv[3] ?? "http://127.0.0.1:18000";
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(B)) {
  console.error("Nur gegen einen lokalen Stack (127.0.0.1/localhost) erlaubt.");
  process.exit(1);
}
const RUN = process.env.RUN ?? String(Date.now());
const J = { "Content-Type": "application/json" };
// Wegwerf-Passwörter, je Lauf neu erzeugt (kein Literal im Repo, Secret-Scan).
const PW1 = `Lab-${randomUUID()}-A1`;
const PW2 = `Lab-${randomUUID()}-B2`;

async function req(method, path, { key = ANON, bearer, body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (key) h.apikey = key;
  if (bearer) h.Authorization = `Bearer ${bearer}`;
  let b;
  if (raw !== undefined) b = raw;
  else if (body !== undefined) { b = JSON.stringify(body); Object.assign(h, J); }
  const r = await fetch(B + path, { method, headers: h, body: b, redirect: "manual" });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const sess = (r) => (r.json?.access_token ? "SESSION" : "keine Session");
const line = (label, r, extra = "") => console.log(`${label}: HTTP ${r.status}${extra}`);

console.log("== 1. Signup mit anon-Key");
let r = await req("POST", "/auth/v1/signup", { body: { email: `signup-${RUN}@example.com`, password: PW1 } });
line("POST /signup", r, ` / ${sess(r)}`);

console.log("== 2. Testkonto per Admin-API (service_role), Session über /verify (wie die App)");
const U = `user-${RUN}@example.com`;
r = await req("POST", "/auth/v1/admin/users", { key: SVC, bearer: SVC, body: { email: U, email_confirm: true, password: PW1 } });
line("admin createUser (service_role)", r);
r = await req("POST", "/auth/v1/admin/generate_link", { key: SVC, bearer: SVC, body: { type: "magiclink", email: U } });
line("admin generate_link (service_role)", r);
r = await req("POST", "/auth/v1/verify", { body: { type: "email", token_hash: r.json?.hashed_token } });
line("POST /verify token_hash (anon)", r, ` / ${sess(r)}`);
const RT = r.json?.refresh_token;

console.log("== 4. Token-Endpunkt");
const pw = { email: U, password: PW1 };
r = await req("POST", "/auth/v1/token?grant_type=password", { body: pw });
line("grant_type=password", r, ` / ${sess(r)}`);
line("grant_type=pkce", await req("POST", "/auth/v1/token?grant_type=pkce", { body: { auth_code: "x", code_verifier: "y" } }));
r = await req("POST", "/auth/v1/token?grant_type=refresh_token&grant_type=password", { body: pw });
line("Query doppelt (refresh_token, password)", r, ` / ${sess(r)}`);
r = await req("POST", "/auth/v1/token?grant_type=password&grant_type=refresh_token", { body: pw });
line("Query doppelt (password, refresh_token)", r, ` / ${sess(r)}`);
r = await req("POST", "/auth/v1/token?grant_type=refresh_token", {
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  raw: `grant_type=password&email=${encodeURIComponent(U)}&password=${encodeURIComponent(PW1)}`,
});
line("Query refresh_token + Form-Body grant_type=password", r, ` / ${sess(r)}`);
r = await req("POST", "/auth/v1/token?grant_type=refresh_token", {
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  raw: `grant_type=password&{"email":"${U}","password":"${PW1}"}`,
});
line("Query refresh_token + Form/JSON-Mischkörper", r, ` / ${sess(r)}`);
line("grant_type=REFRESH_TOKEN (Gross)", await req("POST", "/auth/v1/token?grant_type=REFRESH_TOKEN", { body: {} }));
r = await req("POST", "/auth/v1/token/?grant_type=password", { body: pw });
line("token/ (Slash) password", r, ` / ${sess(r)}`);
r = await req("POST", "/auth/v1/token?grant_type=password%00", { body: pw });
line("grant_type=password%00", r, ` / ${sess(r)}`);
r = await req("POST", "/auth/v1/token?grant_type=refresh_token%26grant_type%3Dpassword", { body: pw });
line("grant_type=refresh_token%26grant_type%3Dpassword", r, ` / ${sess(r)}`);
r = await req("POST", "/auth/v1/token?grant%5Ftype=password", { body: pw });
line("grant%5Ftype=password", r, ` / ${sess(r)}`);
r = await req("POST", "/auth/v1/token?grant_type=refresh_token;grant_type=password", { body: pw });
line("grant_type=refresh_token;grant_type=password", r, ` / ${sess(r)}`);
line("GET /token?grant_type=refresh_token", await req("GET", "/auth/v1/token?grant_type=refresh_token"));
r = await req("POST", "/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: RT } });
line("grant_type=refresh_token (anon)", r, ` / ${r.json?.access_token ? "neue Session" : "FEHLER"}`);
const AT2 = r.json?.access_token, RT2 = r.json?.refresh_token;

console.log("== 3. Nutzer-JWT gegen /user");
line("GET /user", await req("GET", "/auth/v1/user", { bearer: AT2 }));
r = await req("PUT", "/auth/v1/user", { bearer: AT2, body: { email: `changed-${RUN}@example.com` } });
line("PUT /user {email}", r);
line("PUT /user {password}", await req("PUT", "/auth/v1/user", { bearer: AT2, body: { password: PW2 } }));
line("PUT /user/ (Slash)", await req("PUT", "/auth/v1/user/", { bearer: AT2, body: { data: { x: 1 } } }));
line("PUT /USER (Gross)", await req("PUT", "/auth/v1/USER", { bearer: AT2, body: { data: { x: 1 } } }));
line("PUT /%75ser (kodiert)", await req("PUT", "/auth/v1/%75ser", { bearer: AT2, body: { data: { x: 1 } } }));
line("PUT //user (Doppelslash)", await req("PUT", "/auth/v1//user", { bearer: AT2, body: { data: { x: 1 } } }));
line("PUT /user?x=1", await req("PUT", "/auth/v1/user?x=1", { bearer: AT2, body: { data: { x: 1 } } }));
line("PATCH /user", await req("PATCH", "/auth/v1/user", { bearer: AT2, body: { data: { x: 1 } } }));
line("PUT /user mit X-HTTP-Method-Override GET", await req("PUT", "/auth/v1/user", { bearer: AT2, headers: { "X-HTTP-Method-Override": "GET" }, body: { data: { x: 1 } } }));

console.log("== 5. Weitere Endpunkte mit anon-Key");
for (const p of ["otp", "magiclink", "recover", "resend", "invite", "reauthenticate", "factors", "admin/users", "sso", "settings", "health"]) {
  line(`POST /${p}`, await req("POST", `/auth/v1/${p}`, { body: { email: `x-${RUN}@example.com`, type: "signup" } }));
}
line("GET /settings", await req("GET", "/auth/v1/settings"));
line("GET /admin/users (anon)", await req("GET", "/auth/v1/admin/users"));
line("GET /user/identities/authorize (anon)", await req("GET", "/auth/v1/user/identities/authorize?provider=github", { bearer: AT2 }));
line("GET /.well-known/jwks.json (ohne Key)", await req("GET", "/auth/v1/.well-known/jwks.json", { key: null }));
line("GET /verify (ohne Key)", await req("GET", "/auth/v1/verify?token=x&type=magiclink&redirect_to=http://localhost:3000", { key: null }));
line("GET /callback (ohne Key)", await req("GET", "/auth/v1/callback", { key: null }));
line("GET /authorize (ohne Key)", await req("GET", "/auth/v1/authorize?provider=github", { key: null }));
for (const p of ["/auth/v1/token?grant_type=refresh_token", "/auth/v1/user", "/auth/v1/logout", "/auth/v1/otp"]) {
  const o = await fetch(B + p, { method: "OPTIONS", headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "apikey,authorization,content-type" } });
  console.log(`OPTIONS ${p}: HTTP ${o.status}, ACAO=${o.headers.get("access-control-allow-origin") ?? "-"}`);
}

console.log("== 6. OTP-Flut: 120x POST /otp mit anon-Key");
const counts = {};
for (let i = 0; i < 120; i++) {
  const x = await req("POST", "/auth/v1/otp", { body: { email: U, create_user: false } });
  counts[x.status] = (counts[x.status] ?? 0) + 1;
}
console.log("Statusverteilung:", JSON.stringify(counts));

console.log("== 7. App-Pfad: OTP mit Service-Role-Key (wie nach Slice 2)");
const U3 = `user3-${RUN}@example.com`;
await req("POST", "/auth/v1/admin/users", { key: SVC, bearer: SVC, body: { email: U3, email_confirm: true } });
line("POST /otp service_role, bestätigtes Konto, create_user=false", await req("POST", "/auth/v1/otp", { key: SVC, bearer: SVC, body: { email: U3, create_user: false } }));
const U4 = `user4-${RUN}@example.com`;
r = await req("POST", "/auth/v1/otp", { key: SVC, bearer: SVC, body: { email: U4, create_user: false } });
line("POST /otp service_role, unbekannte Adresse, create_user=false", r, ` (${r.json?.error_code ?? r.json?.code ?? "-"})`);
line("GET /admin/users (service_role)", await req("GET", "/auth/v1/admin/users?page=1&per_page=1", { key: SVC, bearer: SVC }));
r = await req("POST", "/auth/v1/token?grant_type=password", { key: SVC, bearer: SVC, body: pw });
line("grant_type=password mit service_role (Admin-Vollzugriff)", r);

console.log("== 8. Logout");
line("POST /logout?scope=local (JWT)", await req("POST", "/auth/v1/logout?scope=local", { bearer: AT2 }));
line("Refresh mit abgemeldetem Token", await req("POST", "/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: RT2 } }));
