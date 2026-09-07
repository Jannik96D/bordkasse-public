-- ═══════════════════════════════════════════════════════════════════════
-- pgTAP — Sanierungsplan 2026-09, PR 7 (Purge/DSGVO):
--
-- 1. Migration 0053: CHECK-Constraint tx_credit_to_all_consistency
--    (`NOT credit_to_all OR credit_to IS NULL`) — ein Insert-Versuch mit
--    credit_to_all=TRUE UND gesetztem credit_to muss abgelehnt werden.
--
-- 2. Migration 0054 (D6): purge_expired_trip_data() räumt zusätzlich
--    audit_log-Zeilen mit trip_id IS NULL nach 90 Tagen Karenzzeit auf
--    (Törn wurde hart gelöscht, ON DELETE SET NULL — solche Zeilen sind
--    wegen der RLS-Policy aus 0034 [trip_id IS NOT NULL AND
--    is_trip_skipper(trip_id)] für niemanden mehr einsehbar). Eine zu
--    junge trip_id-IS-NULL-Zeile (< 90 Tage) muss stehen bleiben, eine
--    trip_id-IS-NULL-Zeile älter als 90 Tage muss verschwinden — und eine
--    alte Zeile MIT trip_id (laufender Törn, nicht purge-fällig) darf
--    NICHT mitgelöscht werden.
--
-- Lauf: cd webapp && supabase test db
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(6);

-- ── 1. CHECK-Constraint tx_credit_to_all_consistency ──────────────────

INSERT INTO persons(id, display_name) VALUES
  ('55550000-0000-4000-8000-000000000001', 'Check P1'),
  ('55550000-0000-4000-8000-000000000002', 'Check P2');

INSERT INTO trips(id, name, start_date, end_date, skipper_id) VALUES
  ('55550000-0000-4000-8000-0000000000aa', 'pgTAP CheckConstraint',
   '2020-01-01', '2020-01-10', '55550000-0000-4000-8000-000000000001');

-- Gültig: direkte Gutschrift, credit_to_all=FALSE + credit_to gesetzt.
SELECT lives_ok(
  $$INSERT INTO transactions(id, trip_id, type, date, amount, credit_from, credit_to, credit_to_all)
    VALUES ('55550000-0000-4000-8000-0000000000e1', '55550000-0000-4000-8000-0000000000aa',
            'credit', '2020-01-02', 10,
            '55550000-0000-4000-8000-000000000002', '55550000-0000-4000-8000-000000000001', FALSE)$$,
  'direkte Gutschrift (credit_to_all=FALSE, credit_to gesetzt) ist erlaubt');

-- Gültig: "An Alle", credit_to_all=TRUE + credit_to NULL.
SELECT lives_ok(
  $$INSERT INTO transactions(id, trip_id, type, date, amount, credit_from, credit_to, credit_to_all)
    VALUES ('55550000-0000-4000-8000-0000000000e2', '55550000-0000-4000-8000-0000000000aa',
            'credit', '2020-01-03', 10,
            '55550000-0000-4000-8000-000000000002', NULL, TRUE)$$,
  '"An Alle" (credit_to_all=TRUE, credit_to=NULL) ist erlaubt');

-- Ungültig: credit_to_all=TRUE UND credit_to gesetzt gleichzeitig.
SELECT throws_ok(
  $$INSERT INTO transactions(id, trip_id, type, date, amount, credit_from, credit_to, credit_to_all)
    VALUES ('55550000-0000-4000-8000-0000000000e3', '55550000-0000-4000-8000-0000000000aa',
            'credit', '2020-01-04', 10,
            '55550000-0000-4000-8000-000000000002', '55550000-0000-4000-8000-000000000001', TRUE)$$,
  '23514', NULL,
  'credit_to_all=TRUE + credit_to gesetzt wird vom CHECK abgelehnt');

-- ── 2. purge_expired_trip_data() räumt alte trip_id-IS-NULL-Audit-Zeilen ──

-- (a) zu jung (< 90 Tage) → bleibt.
INSERT INTO audit_log(id, table_name, operation, record_id, trip_id, actor_person_id, created_at)
VALUES (
  '55550000-0000-4000-8000-0000000000a1', 'trips', 'DELETE',
  '55550000-0000-4000-8000-000000000099', NULL,
  '55550000-0000-4000-8000-000000000001', now() - interval '10 days'
);

-- (b) alt (> 90 Tage), trip_id IS NULL → muss weg.
INSERT INTO audit_log(id, table_name, operation, record_id, trip_id, actor_person_id, created_at)
VALUES (
  '55550000-0000-4000-8000-0000000000a2', 'trips', 'DELETE',
  '55550000-0000-4000-8000-000000000098', NULL,
  '55550000-0000-4000-8000-000000000001', now() - interval '120 days'
);

-- (c) alt (> 90 Tage), ABER mit trip_id (laufender, nicht purge-fälliger
--     Törn) → darf NICHT mitgelöscht werden, nur die trip_id-IS-NULL-
--     Regel greift.
INSERT INTO trips(id, name, start_date, end_date, skipper_id) VALUES
  ('55550000-0000-4000-8000-0000000000bb', 'pgTAP Audit-Trip-Alive',
   '2020-01-01', '2020-01-10', '55550000-0000-4000-8000-000000000001');
INSERT INTO audit_log(id, table_name, operation, record_id, trip_id, actor_person_id, created_at)
VALUES (
  '55550000-0000-4000-8000-0000000000a3', 'trips', 'UPDATE',
  '55550000-0000-4000-8000-0000000000bb', '55550000-0000-4000-8000-0000000000bb',
  '55550000-0000-4000-8000-000000000001', now() - interval '120 days'
);

-- DO-Block statt nacktem SELECT: purge_expired_trip_data() ist eine
-- set-returning Function (RETURNS TABLE) — ein bloßes `SELECT
-- purge_expired_trip_data();` würde ein Resultset auf stdout drucken, das
-- die TAP-Ausgabe von pg_prove verunreinigen kann. PERFORM verwirft das
-- Ergebnis sauber (uns interessiert hier nur der Seiteneffekt).
DO $$
BEGIN
  PERFORM purge_expired_trip_data();
END;
$$;

SELECT ok(
  EXISTS(SELECT 1 FROM audit_log WHERE id = '55550000-0000-4000-8000-0000000000a1'),
  'zu junge trip_id-IS-NULL-Audit-Zeile (< 90 Tage) bleibt erhalten');
SELECT ok(
  NOT EXISTS(SELECT 1 FROM audit_log WHERE id = '55550000-0000-4000-8000-0000000000a2'),
  'alte trip_id-IS-NULL-Audit-Zeile (> 90 Tage) wird gelöscht');
SELECT ok(
  EXISTS(SELECT 1 FROM audit_log WHERE id = '55550000-0000-4000-8000-0000000000a3'),
  'alte Audit-Zeile MIT trip_id bleibt unangetastet (nur trip_id IS NULL betroffen)');

SELECT * FROM finish();
ROLLBACK;
