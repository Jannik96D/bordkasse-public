-- ═══════════════════════════════════════════════════════════════════════
-- 0036_login_rate_limit.sql — Rate-Limit für Magic-Link-Anforderungen
--
-- Schützt den Login-Endpoint (app/login/actions.ts → signInWithOtp) gegen
-- Flutung: Mailbombing einer bekannten Crew-Adresse und Verbrauch des
-- Supabase-Auth-/Mail-Kontingents.
--
-- Warum in Postgres und nicht in-memory? Die App läuft serverless (Vercel).
-- Ein Modul-`Map` lebt pro Function-Instanz und überlebt keinen Cold-Start
-- → kein verlässliches, instanzübergreifendes Limit. Die vorhandene
-- Supabase-DB ist der einzige geteilte Zustand ohne neue Infrastruktur/Kosten.
--
-- Fixed-Window-Counter: pro Schlüssel (z. B. "email:foo@bar" / "ip:1.2.3.4")
-- genau EINE Zeile, die innerhalb des Fensters hochgezählt und danach
-- zurückgesetzt wird. Kein Anwachsen pro Versuch, nur pro distinktem Schlüssel
-- (→ cleanup_login_rate_limit() im täglichen Purge-Cron räumt Altlasten weg).
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists login_rate_limit (
  key          text primary key,
  window_start timestamptz not null default now(),
  attempts     int         not null default 0
);

-- Nur die SECURITY-DEFINER-Funktionen (als Owner) dürfen die Tabelle anfassen.
-- RLS an + keine Policy = direkter Zugriff durch anon/authenticated gesperrt.
alter table login_rate_limit enable row level security;
revoke all on table login_rate_limit from anon, authenticated;

-- Hochzählen + Prüfen in einem atomaren Schritt. Das `on conflict do update`
-- nimmt einen Row-Lock → gleichzeitige Aufrufe serialisieren, keine Race.
-- Rückgabe: true = erlaubt (Schwelle noch NICHT überschritten), false = blocken.
create or replace function bump_login_rate_limit(
  p_key            text,
  p_max            int,
  p_window_seconds int
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_attempts int;
  v_window   interval := p_window_seconds * interval '1 second';
begin
  insert into login_rate_limit as r (key, window_start, attempts)
    values (p_key, now(), 1)
  on conflict (key) do update
    set attempts     = case when r.window_start > now() - v_window then r.attempts + 1 else 1   end,
        window_start = case when r.window_start > now() - v_window then r.window_start     else now() end
  returning attempts into v_attempts;

  return v_attempts <= p_max;
end;
$$;

-- Aufräumen alter Zähler (vom täglichen Purge-Cron aufgerufen).
create or replace function cleanup_login_rate_limit()
returns void
language sql
security definer
set search_path = pg_catalog, public
as $$
  delete from login_rate_limit where window_start < now() - interval '1 day';
$$;

revoke all on function bump_login_rate_limit(text, int, int) from public;
revoke all on function cleanup_login_rate_limit() from public;
grant execute on function bump_login_rate_limit(text, int, int) to anon, authenticated, service_role;
grant execute on function cleanup_login_rate_limit() to service_role;
