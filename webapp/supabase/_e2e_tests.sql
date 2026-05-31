-- ═══════════════════════════════════════════════════════════════════════
-- _e2e_tests.sql — Selbst-prüfender Integrationstest gegen die LIVE-Views
--
-- Warum dieser Test?
--   __tests__/calc.test.ts prüft nur den TS-Mirror (lib/calc/*), der laut
--   CLAUDE.md NICHT im Render-Pfad läuft. Der Produktiv-Pfad sind die
--   SQL-Views/Funktionen. _smoke_tests.sql druckt nur Zeilen zum Angucken
--   (keine echten Assertions → kann nicht fehlschlagen).
--   Dieser Test legt eigene, isolierte Törns/Crews an, feuert alle Szenarien
--   + Edge-Cases gegen die ECHTEN Views (v_transaction_shares, v_balances,
--   v_balances_bordkasse_only, simplify_debts, v_prepayment_payments,
--   v_prepayment_pending) und ASSERTET jedes Ergebnis. Am Ende: ROLLBACK →
--   die DB bleibt unberührt.
--
-- Aufruf (gegen lokales Supabase):
--   docker exec -i supabase_db_bordkasse psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f /dev/stdin < supabase/_e2e_tests.sql
--   bzw. cat supabase/_e2e_tests.sql | docker exec -i supabase_db_bordkasse \
--        psql -U postgres -d postgres -v ON_ERROR_STOP=1
--
-- Test-Design (anerkannte Prinzipien):
--   • Isolation       — jedes Szenario eigener Törn, kein Cross-Talk.
--   • Self-validating  — jede Prüfung asserted Ist vs. Soll (FIRST).
--   • Boundary-Value   — Anwesenheits-Grenzen (Tag davor/genau/danach),
--                        Alkohol = 0 / Teil / voll, Crew N=1, 0 Trinker,
--                        alle Trinker, gelöschte Buchungen.
--   • Invarianten      — Σ Anteile = Betrag(+Tip); Σ Bilanz = 0;
--                        Überweisungen ≤ N-1; Summe Überweisungen = Schuld.
-- ═══════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
\timing off
BEGIN;

CREATE TEMP TABLE _results (
  id     serial,
  name   text,
  ok     boolean,
  got    text,
  want   text
) ON COMMIT DROP;

-- numerischer Vergleich mit Toleranz (Default 0,5 Cent)
CREATE FUNCTION pg_temp.chk(nm text, got numeric, want numeric, tol numeric DEFAULT 0.005)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO _results(name, ok, got, want)
  VALUES (nm,
          got IS NOT NULL AND abs(got - want) <= tol,
          COALESCE(got::text, 'NULL'),
          want::text);
END $$;

-- ganzzahliger Vergleich (exakt)
CREATE FUNCTION pg_temp.chk_i(nm text, got bigint, want bigint)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO _results(name, ok, got, want)
  VALUES (nm, got = want, COALESCE(got::text,'NULL'), want::text);
END $$;

-- Boolean-Vergleich
CREATE FUNCTION pg_temp.chk_b(nm text, got boolean, want boolean)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO _results(name, ok, got, want)
  VALUES (nm, got IS NOT DISTINCT FROM want, COALESCE(got::text,'NULL'), want::text);
END $$;

DO $main$
DECLARE
  -- Personen (global)
  p1 uuid; p2 uuid; p3 uuid; p4 uuid; p5 uuid;
  p6 uuid; p7 uuid; p8 uuid; p9 uuid; p10 uuid;
  -- Törns
  t_a uuid; t_b uuid; t_c uuid; t_d uuid; t_e uuid; t_f uuid; t_g uuid;
  -- Hilfs-IDs
  tx uuid; trA uuid; trB uuid;
  v  numeric;
  cnt bigint;
  tot numeric;

  -- Trip A Transaktions-IDs (Share-Szenarien)
  s1 uuid; s2 uuid; s2a uuid; s2b uuid; s3 uuid; s4 uuid; s4b uuid;
  s5 uuid; spp uuid; e1 uuid; e2 uuid; e3 uuid; e4 uuid; e5 uuid;

  pd1 uuid; pd2 uuid;          -- Trip D Personen
  pf1 uuid; pf2 uuid; pf3 uuid; pf4 uuid;  -- Trip F Personen
  pe1 uuid;                    -- Trip E Person
BEGIN
  -- ═══ Personen anlegen ═══════════════════════════════════════════════
  INSERT INTO persons(display_name) VALUES
    ('A1'),('A2'),('A3'),('A4'),('A5'),('A6'),('A7'),('A8'),('A9'),('A10');
  SELECT id INTO p1 FROM persons WHERE display_name='A1' ORDER BY created_at DESC LIMIT 1;
  SELECT id INTO p2 FROM persons WHERE display_name='A2' ORDER BY created_at DESC LIMIT 1;
  SELECT id INTO p3 FROM persons WHERE display_name='A3' ORDER BY created_at DESC LIMIT 1;
  SELECT id INTO p4 FROM persons WHERE display_name='A4' ORDER BY created_at DESC LIMIT 1;
  SELECT id INTO p5 FROM persons WHERE display_name='A5' ORDER BY created_at DESC LIMIT 1;
  SELECT id INTO p6 FROM persons WHERE display_name='A6' ORDER BY created_at DESC LIMIT 1;
  SELECT id INTO p7 FROM persons WHERE display_name='A7' ORDER BY created_at DESC LIMIT 1;
  SELECT id INTO p8 FROM persons WHERE display_name='A8' ORDER BY created_at DESC LIMIT 1;
  SELECT id INTO p9 FROM persons WHERE display_name='A9' ORDER BY created_at DESC LIMIT 1;
  SELECT id INTO p10 FROM persons WHERE display_name='A10' ORDER BY created_at DESC LIMIT 1;

  -- ═══════════════════════════════════════════════════════════════════
  -- TRIP A — Share-Szenarien (11 Tage, 05.–15.04.2026)
  --   9 Voll-Crew (A1-A5,A7-A10) + A6 (Finn) ab 10.04. → 6 Tage
  --   Trinker: A3,A4,A5
  -- ═══════════════════════════════════════════════════════════════════
  INSERT INTO trips(name, start_date, end_date, skipper_id)
  VALUES ('E2E Trip A', '2026-04-05', '2026-04-15', p1) RETURNING id INTO t_a;

  INSERT INTO trip_members(trip_id, person_id, is_alcoholic) VALUES
    (t_a,p1,false),(t_a,p2,false),(t_a,p3,true),(t_a,p4,true),(t_a,p5,true),
    (t_a,p7,false),(t_a,p8,false),(t_a,p9,false),(t_a,p10,false);
  INSERT INTO trip_members(trip_id, person_id, on_board_from, on_board_to, is_alcoholic)
    VALUES (t_a, p6, '2026-04-10', '2026-04-15', false);  -- Finn, 6 Tage

  -- ── S1: Gleichmäßig 100 € → je 10 € ────────────────────────────────
  INSERT INTO transactions(trip_id,type,date,description,amount,paid_by,split_type)
    VALUES (t_a,'expense','2026-04-06','S1',100,p1,'equal') RETURNING id INTO s1;
  SELECT share INTO v FROM v_transaction_shares WHERE transaction_id=s1 AND person_id=p1;
  PERFORM pg_temp.chk('S1 equal: A1 share', v, 10);
  SELECT share INTO v FROM v_transaction_shares WHERE transaction_id=s1 AND person_id=p6;
  PERFORM pg_temp.chk('S1 equal: Finn share (auch ohne Anwesenheit)', v, 10);
  SELECT sum(share) INTO v FROM v_transaction_shares WHERE transaction_id=s1;
  PERFORM pg_temp.chk('S1 equal: Σ shares = amount', v, 100);

  -- ── S2: An Bord 80 € am 08.04. → Finn weg, 9× 8,889 ────────────────
  INSERT INTO transactions(trip_id,type,date,description,amount,paid_by,split_type)
    VALUES (t_a,'expense','2026-04-08','S2',80,p1,'on_board') RETURNING id INTO s2;
  SELECT share INTO v FROM v_transaction_shares WHERE transaction_id=s2 AND person_id=p6;
  PERFORM pg_temp.chk('S2 on_board: Finn am 08.04. = 0', v, 0);
  SELECT share INTO v FROM v_transaction_shares WHERE transaction_id=s2 AND person_id=p1;
  PERFORM pg_temp.chk('S2 on_board: Voll-Crew = 80/9', v, 80.0/9.0);
  SELECT sum(share) INTO v FROM v_transaction_shares WHERE transaction_id=s2;
  PERFORM pg_temp.chk('S2 on_board: Σ shares = 80', v, 80);

  -- ── S2a: Boundary — An Bord am 10.04. (Finns Ankunftstag, inklusiv) ─
  INSERT INTO transactions(trip_id,type,date,description,amount,paid_by,split_type)
    VALUES (t_a,'expense','2026-04-10','S2a',100,p1,'on_board') RETURNING id INTO s2a;
  SELECT share INTO v FROM v_transaction_shares WHERE transaction_id=s2a AND person_id=p6;
  PERFORM pg_temp.chk('S2a boundary: Finn am Ankunftstag IST dabei (10er-Split)', v, 10);

  -- ── S2b: Boundary — An Bord am 09.04. (Tag vor Ankunft) ────────────
  INSERT INTO transactions(trip_id,type,date,description,amount,paid_by,split_type)
    VALUES (t_a,'expense','2026-04-09','S2b',90,p1,'on_board') RETURNING id INTO s2b;
  SELECT share INTO v FROM v_transaction_shares WHERE transaction_id=s2b AND person_id=p6;
  PERFORM pg_temp.chk('S2b boundary: Finn am Tag vor Ankunft = 0', v, 0);
  SELECT share INTO v FROM v_transaction_shares WHERE transaction_id=s2b AND person_id=p1;
  PERFORM pg_temp.chk('S2b boundary: Voll-Crew = 90/9 = 10', v, 10);

  -- ── S3: An Bord + Alkohol 100/30 am 12.04. → Trinker 17, andere 7 ──
  INSERT INTO transactions(trip_id,type,date,description,amount,alcohol_amount,paid_by,split_type)
    VALUES (t_a,'expense','2026-04-12','S3',100,30,p1,'on_board') RETURNING id INTO s3;
  SELECT share INTO v FROM v_transaction_shares WHERE transaction_id=s3 AND person_id=p3;
  PERFORM pg_temp.chk('S3 alk: Trinker A3 = 17', v, 17);
  SELECT share INTO v FROM v_transaction_shares WHERE transaction_id=s3 AND person_id=p1;
  PERFORM pg_temp.chk('S3 alk: Nicht-Trinker A1 = 7', v, 7);
  SELECT sum(share) INTO v FROM v_transaction_shares WHERE transaction_id=s3;
  PERFORM pg_temp.chk('S3 alk: Σ shares = 100', v, 100);

  -- ── S4: Zeitanteilig 210 € → Voll 22, Finn 12 ──────────────────────
  INSERT INTO transactions(trip_id,type,date,description,amount,paid_by,split_type)
    VALUES (t_a,'expense','2026-04-08','S4',210,p1,'time_proportional') RETURNING id INTO s4;
  SELECT share INTO v FROM v_transaction_shares WHERE transaction_id=s4 AND person_id=p1;
  PERFORM pg_temp.chk('S4 zeit: Voll-Crew = 22', v, 22);
  SELECT share INTO v FROM v_transaction_shares WHERE transaction_id=s4 AND person_id=p6;
  PERFORM pg_temp.chk('S4 zeit: Finn (6 Tage) = 12', v, 12);
  SELECT sum(share) INTO v FROM v_transaction_shares WHERE transaction_id=s4;
  PERFORM pg_temp.chk('S4 zeit: Σ shares = 210', v, 210);

  -- ── S4b: Zeitanteilig + Alkohol 200/60 → Trinker 34,67, Finn 8 ─────
  INSERT INTO transactions(trip_id,type,date,description,amount,alcohol_amount,paid_by,split_type)
    VALUES (t_a,'expense','2026-04-08','S4b',200,60,p1,'time_proportional') RETURNING id INTO s4b;
  SELECT share INTO v FROM v_transaction_shares WHERE transaction_id=s4b AND person_id=p3;
  PERFORM pg_temp.chk('S4b zeit+alk: Trinker (11 T) = 14,667+20', v, 140.0*11/105 + 60.0*11/33);
  SELECT share INTO v FROM v_transaction_shares WHERE transaction_id=s4b AND person_id=p6;
  PERFORM pg_temp.chk('S4b zeit+alk: Finn Nicht-Trinker (6 T) = 8', v, 8);
  SELECT share INTO v FROM v_transaction_shares WHERE transaction_id=s4b AND person_id=p1;
  PERFORM pg_temp.chk('S4b zeit+alk: Voll Nicht-Trinker = 14,667', v, 140.0*11/105);
  SELECT sum(share) INTO v FROM v_transaction_shares WHERE transaction_id=s4b;
  PERFORM pg_temp.chk('S4b zeit+alk: Σ shares = 200', v, 200);

  -- ── S5: Individuell 120 € auf A2,A3,A4 → je 40 ─────────────────────
  INSERT INTO transactions(trip_id,type,date,description,amount,paid_by,split_type)
    VALUES (t_a,'expense','2026-04-08','S5',120,p1,'individual') RETURNING id INTO s5;
  INSERT INTO transaction_participants(transaction_id,person_id) VALUES (s5,p2),(s5,p3),(s5,p4);
  SELECT share INTO v FROM v_transaction_shares WHERE transaction_id=s5 AND person_id=p3;
  PERFORM pg_temp.chk('S5 individuell: markiert A3 = 40', v, 40);
  SELECT share INTO v FROM v_transaction_shares WHERE transaction_id=s5 AND person_id=p1;
  PERFORM pg_temp.chk('S5 individuell: nicht markiert A1 = 0', v, 0);
  SELECT sum(share) INTO v FROM v_transaction_shares WHERE transaction_id=s5;
  PERFORM pg_temp.chk('S5 individuell: Σ shares = 120', v, 120);

  -- ── S8: Pro Person 56,30 € mit Einzelbeträgen ──────────────────────
  INSERT INTO transactions(trip_id,type,date,description,amount,paid_by,split_type)
    VALUES (t_a,'expense','2026-04-08','S8',56.30,p1,'per_person') RETURNING id INTO spp;
  INSERT INTO transaction_participants(transaction_id,person_id,amount)
    VALUES (spp,p1,12.50),(spp,p2,14.50),(spp,p3,20),(spp,p7,9.30);
  SELECT share INTO v FROM v_transaction_shares WHERE transaction_id=spp AND person_id=p2;
  PERFORM pg_temp.chk('S8 pro Person: A2 = 14,50', v, 14.50);
  SELECT share INTO v FROM v_transaction_shares WHERE transaction_id=spp AND person_id=p5;
  PERFORM pg_temp.chk('S8 pro Person: nicht beteiligt A5 = 0', v, 0);
  SELECT sum(share) INTO v FROM v_transaction_shares WHERE transaction_id=spp;
  PERFORM pg_temp.chk('S8 pro Person: Σ shares = 56,30', v, 56.30);

  -- ── E1: Alkohol OHNE Trinker im Active-Set → auf alle Aktiven ──────
  --   individuell A1,A2 (beide Nicht-Trinker), 100 € / 30 € Alkohol
  --   base 70/2=35 + alk 30/2=15 → je 50
  INSERT INTO transactions(trip_id,type,date,description,amount,alcohol_amount,paid_by,split_type)
    VALUES (t_a,'expense','2026-04-08','E1',100,30,p1,'individual') RETURNING id INTO e1;
  INSERT INTO transaction_participants(transaction_id,person_id) VALUES (e1,p1),(e1,p2);
  SELECT share INTO v FROM v_transaction_shares WHERE transaction_id=e1 AND person_id=p1;
  PERFORM pg_temp.chk('E1 alk-ohne-Trinker: A1 = 50', v, 50);
  SELECT sum(share) INTO v FROM v_transaction_shares WHERE transaction_id=e1;
  PERFORM pg_temp.chk('E1 alk-ohne-Trinker: Σ shares = 100', v, 100);

  -- ── E2: Alkohol = voller Betrag (base=0), An Bord, 3 Trinker ───────
  INSERT INTO transactions(trip_id,type,date,description,amount,alcohol_amount,paid_by,split_type)
    VALUES (t_a,'expense','2026-04-12','E2',60,60,p1,'on_board') RETURNING id INTO e2;
  SELECT share INTO v FROM v_transaction_shares WHERE transaction_id=e2 AND person_id=p3;
  PERFORM pg_temp.chk('E2 voll-alk: Trinker = 60/3 = 20', v, 20);
  SELECT share INTO v FROM v_transaction_shares WHERE transaction_id=e2 AND person_id=p1;
  PERFORM pg_temp.chk('E2 voll-alk: Nicht-Trinker = 0', v, 0);
  SELECT sum(share) INTO v FROM v_transaction_shares WHERE transaction_id=e2;
  PERFORM pg_temp.chk('E2 voll-alk: Σ shares = 60', v, 60);

  -- ── E3: Nur Trinker markiert (individuell A3,A4,A5) + Alkohol ──────
  --   90/30 alk, 3 Markierte (alle Trinker): base 60/3=20 + alk 30/3=10 → 30
  INSERT INTO transactions(trip_id,type,date,description,amount,alcohol_amount,paid_by,split_type)
    VALUES (t_a,'expense','2026-04-12','E3',90,30,p1,'individual') RETURNING id INTO e3;
  INSERT INTO transaction_participants(transaction_id,person_id) VALUES (e3,p3),(e3,p4),(e3,p5);
  SELECT share INTO v FROM v_transaction_shares WHERE transaction_id=e3 AND person_id=p3;
  PERFORM pg_temp.chk('E3 alle-Trinker: A3 = 30', v, 30);
  SELECT sum(share) INTO v FROM v_transaction_shares WHERE transaction_id=e3;
  PERFORM pg_temp.chk('E3 alle-Trinker: Σ shares = 90', v, 90);

  -- ── E4: Trinkgeld proportional auf Gleichmäßig (100 €, Tip 10 €) ───
  INSERT INTO transactions(trip_id,type,date,description,amount,tip_amount,paid_by,split_type)
    VALUES (t_a,'expense','2026-04-06','E4',100,10,p1,'equal') RETURNING id INTO e4;
  SELECT share INTO v FROM v_transaction_shares WHERE transaction_id=e4 AND person_id=p1;
  PERFORM pg_temp.chk('E4 tip-prop: je (100/10)*1,1 = 11', v, 11);
  SELECT sum(share) INTO v FROM v_transaction_shares WHERE transaction_id=e4;
  PERFORM pg_temp.chk('E4 tip-prop: Σ shares = amount+tip = 110', v, 110);

  -- ── E5: Pro Person + Trinkgeld "equal" (View-Verhalten dokumentiert) ─
  --   60 € (20/30/10) + 6 € Tip equal → je base + 6/3 = base+2 → 22/32/12
  --   Hinweis: createExpense ERZWINGT tip=0 bei per_person; dieser View-Pfad
  --   ist via UI unerreichbar — Test prüft die reine View-Logik.
  INSERT INTO transactions(trip_id,type,date,description,amount,tip_amount,tip_distribution,paid_by,split_type)
    VALUES (t_a,'expense','2026-04-08','E5',60,6,'equal',p1,'per_person') RETURNING id INTO e5;
  INSERT INTO transaction_participants(transaction_id,person_id,amount)
    VALUES (e5,p1,20),(e5,p2,30),(e5,p3,10);
  SELECT share INTO v FROM v_transaction_shares WHERE transaction_id=e5 AND person_id=p1;
  PERFORM pg_temp.chk('E5 pp+tip-equal: A1 = 20+2 = 22', v, 22);
  SELECT sum(share) INTO v FROM v_transaction_shares WHERE transaction_id=e5;
  PERFORM pg_temp.chk('E5 pp+tip-equal: Σ shares = 66', v, 66);

  -- ── Globale Invariante über ALLE Trip-A-Ausgaben: Σ share = Σ (amount+tip) ─
  SELECT sum(share) INTO tot FROM v_transaction_shares WHERE trip_id=t_a;
  SELECT sum(amount + tip_amount) INTO v FROM transactions WHERE trip_id=t_a AND type='expense';
  PERFORM pg_temp.chk('Trip A: Σ aller shares = Σ (amount+tip)', tot, v, 0.02);

  -- ═══════════════════════════════════════════════════════════════════
  -- TRIP B — S7 Schulden-Greedy (10 Crew, alle voll anwesend)
  --   300 € equal (A1) + 150 € on_board (A5) → 9 Überweisungen, Σ=360
  -- ═══════════════════════════════════════════════════════════════════
  INSERT INTO trips(name, start_date, end_date, skipper_id)
  VALUES ('E2E Trip B', '2026-04-05', '2026-04-15', p1) RETURNING id INTO t_b;
  INSERT INTO trip_members(trip_id, person_id) VALUES
    (t_b,p1),(t_b,p2),(t_b,p3),(t_b,p4),(t_b,p5),
    (t_b,p6),(t_b,p7),(t_b,p8),(t_b,p9),(t_b,p10);

  INSERT INTO transactions(trip_id,type,date,description,amount,paid_by,split_type) VALUES
    (t_b,'expense','2026-04-06','S7-300',300,p1,'equal'),
    (t_b,'expense','2026-04-07','S7-150',150,p5,'on_board');

  SELECT balance INTO v FROM v_balances WHERE trip_id=t_b AND person_id=p1;
  PERFORM pg_temp.chk('S7 Bilanz: A1 = +255', v, 255);
  SELECT balance INTO v FROM v_balances WHERE trip_id=t_b AND person_id=p5;
  PERFORM pg_temp.chk('S7 Bilanz: A5 = +105', v, 105);
  SELECT balance INTO v FROM v_balances WHERE trip_id=t_b AND person_id=p2;
  PERFORM pg_temp.chk('S7 Bilanz: Schuldner = -45', v, -45);
  SELECT sum(balance) INTO v FROM v_balances WHERE trip_id=t_b;
  PERFORM pg_temp.chk('S7 Bilanz: Σ = 0', v, 0);

  SELECT count(*), coalesce(sum(amount),0) INTO cnt, tot FROM simplify_debts(t_b);
  PERFORM pg_temp.chk_i('S7 Schulden: Anzahl Überweisungen = 9', cnt, 9);
  PERFORM pg_temp.chk('S7 Schulden: Σ Überweisungen = 360', tot, 360);
  PERFORM pg_temp.chk_b('S7 Schulden: ≤ N-1 (9)', cnt <= 9, true);
  PERFORM pg_temp.chk_b('S7 Schulden: alle Beträge > 0',
    (SELECT bool_and(amount > 0) FROM simplify_debts(t_b)), true);

  -- ═══════════════════════════════════════════════════════════════════
  -- TRIP C — S6 Gutschrift "An Alle" (Yacht 2400 zeitanteilig + Ben→Alle 240)
  --   Crew wie A (Finn 6 Tage). Erwartung aus calc.test.ts S6.
  -- ═══════════════════════════════════════════════════════════════════
  INSERT INTO trips(name, start_date, end_date, skipper_id)
  VALUES ('E2E Trip C', '2026-04-05', '2026-04-15', p1) RETURNING id INTO t_c;
  INSERT INTO trip_members(trip_id, person_id) VALUES
    (t_c,p1),(t_c,p2),(t_c,p3),(t_c,p4),(t_c,p5),
    (t_c,p7),(t_c,p8),(t_c,p9),(t_c,p10);
  INSERT INTO trip_members(trip_id, person_id, on_board_from, on_board_to)
    VALUES (t_c, p6, '2026-04-10', '2026-04-15');

  INSERT INTO transactions(trip_id,type,date,description,amount,paid_by,split_type)
    VALUES (t_c,'expense','2026-04-05','Yacht',2400,p1,'time_proportional');
  INSERT INTO transactions(trip_id,type,date,description,amount,credit_from,credit_to)
    VALUES (t_c,'credit','2026-04-05','Ben an Alle',240,p2,NULL);

  SELECT balance INTO v FROM v_balances WHERE trip_id=t_c AND person_id=p1;
  PERFORM pg_temp.chk('S6: Anna = +2121,90', v, 2121.90, 0.01);
  SELECT balance INTO v FROM v_balances WHERE trip_id=t_c AND person_id=p2;
  PERFORM pg_temp.chk('S6: Ben = -11,43', v, -11.43, 0.01);
  SELECT balance INTO v FROM v_balances WHERE trip_id=t_c AND person_id=p6;
  PERFORM pg_temp.chk('S6: Finn = -163,81', v, -163.81, 0.01);
  SELECT balance INTO v FROM v_balances WHERE trip_id=t_c AND person_id=p7;
  PERFORM pg_temp.chk('S6: andere = -278,10', v, -278.10, 0.01);
  SELECT sum(balance) INTO v FROM v_balances WHERE trip_id=t_c;
  PERFORM pg_temp.chk('S6: Σ Bilanz = 0', v, 0, 0.01);

  -- ═══════════════════════════════════════════════════════════════════
  -- TRIP D — Soft-Delete: zählt eine gelöschte Buchung noch in die Bilanz?
  --   2 Crew, 100 € equal. Vorher: +50/-50. Nach deleted_at: erwartet 0/0.
  -- ═══════════════════════════════════════════════════════════════════
  INSERT INTO persons(display_name) VALUES ('D1') RETURNING id INTO pd1;
  INSERT INTO persons(display_name) VALUES ('D2') RETURNING id INTO pd2;
  INSERT INTO trips(name, start_date, end_date, skipper_id)
  VALUES ('E2E Trip D', '2026-04-05', '2026-04-15', pd1) RETURNING id INTO t_d;
  INSERT INTO trip_members(trip_id, person_id) VALUES (t_d,pd1),(t_d,pd2);
  INSERT INTO transactions(trip_id,type,date,description,amount,paid_by,split_type)
    VALUES (t_d,'expense','2026-04-06','D-100',100,pd1,'equal') RETURNING id INTO tx;

  SELECT balance INTO v FROM v_balances WHERE trip_id=t_d AND person_id=pd1;
  PERFORM pg_temp.chk('D vor Delete: D1 = +50', v, 50);

  UPDATE transactions SET deleted_at = now() WHERE id = tx;

  SELECT balance INTO v FROM v_balances WHERE trip_id=t_d AND person_id=pd1;
  PERFORM pg_temp.chk('D nach Delete: v_balances IGNORIERT gelöschte Buchung (D1=0)', v, 0);
  SELECT balance INTO v FROM v_balances WHERE trip_id=t_d AND person_id=pd2;
  PERFORM pg_temp.chk('D nach Delete: v_balances IGNORIERT gelöschte Buchung (D2=0)', v, 0);
  -- Kontrolle: bordkasse_only filtert deleted_at korrekt → keine Zeile mehr
  SELECT count(*) INTO cnt FROM v_balances_bordkasse_only WHERE trip_id=t_d;
  PERFORM pg_temp.chk_i('D nach Delete: v_balances_bordkasse_only filtert korrekt (0 Zeilen)', cnt, 0);

  -- ═══════════════════════════════════════════════════════════════════
  -- TRIP E — Degeneriert: N=1, "An Alle" → Division durch (N-1)=0 darf
  --   NICHT crashen (NULLIF-Guard). Erwartung: kein Fehler.
  -- ═══════════════════════════════════════════════════════════════════
  INSERT INTO persons(display_name) VALUES ('E1person') RETURNING id INTO pe1;
  INSERT INTO trips(name, start_date, end_date, skipper_id)
  VALUES ('E2E Trip E', '2026-04-05', '2026-04-15', pe1) RETURNING id INTO t_e;
  INSERT INTO trip_members(trip_id, person_id) VALUES (t_e,pe1);
  -- Ausgabe in 1-Personen-Törn: share=100, paid=100 → Bilanz 0
  INSERT INTO transactions(trip_id,type,date,description,amount,paid_by,split_type)
    VALUES (t_e,'expense','2026-04-06','E-100',100,pe1,'equal');
  SELECT balance INTO v FROM v_balances WHERE trip_id=t_e AND person_id=pe1;
  PERFORM pg_temp.chk('E N=1: Eigen-Ausgabe Bilanz = 0', v, 0);
  -- "An Alle" mit N=1: kein Empfänger → NULLIF-Guard verhindert Crash
  INSERT INTO transactions(trip_id,type,date,description,amount,credit_from,credit_to)
    VALUES (t_e,'credit','2026-04-06','solo an alle',50,pe1,NULL);
  SELECT balance INTO v FROM v_balances WHERE trip_id=t_e AND person_id=pe1;
  PERFORM pg_temp.chk('E N=1: "An Alle" crasht nicht; credit_given ohne Empfänger (Bilanz=+50)', v, 50);

  -- ═══════════════════════════════════════════════════════════════════
  -- TRIP F — Anzahlungs-Views (Plan/Tranchen/Zahlungen/Pending)
  --   4 Crew, gleichmäßig 1200 → je 300. 2 Tranchen 50/50. Vorstrecker F1.
  --   F2 zahlt Tranche 1 voll (bestätigt). F3 meldet selbst (pending).
  -- ═══════════════════════════════════════════════════════════════════
  INSERT INTO persons(display_name) VALUES ('F1') RETURNING id INTO pf1;
  INSERT INTO persons(display_name) VALUES ('F2') RETURNING id INTO pf2;
  INSERT INTO persons(display_name) VALUES ('F3') RETURNING id INTO pf3;
  INSERT INTO persons(display_name) VALUES ('F4') RETURNING id INTO pf4;
  INSERT INTO trips(name, start_date, end_date, skipper_id)
  VALUES ('E2E Trip F', '2027-07-01', '2027-07-10', pf1) RETURNING id INTO t_f;
  INSERT INTO trip_members(trip_id, person_id) VALUES (t_f,pf1),(t_f,pf2),(t_f,pf3),(t_f,pf4);

  INSERT INTO prepayment_plan(trip_id, split_method, total_amount, advancer_person_id)
    VALUES (t_f, 'gleichmaessig', 1200, pf1);
  INSERT INTO prepayment_obligations(trip_id, person_id, total_amount) VALUES
    (t_f,pf1,300),(t_f,pf2,300),(t_f,pf3,300),(t_f,pf4,300);
  INSERT INTO prepayment_tranches(trip_id, due_date, label, percent, sort_order)
    VALUES (t_f,'2027-05-01','1. Anzahlung',50,0) RETURNING id INTO trA;
  INSERT INTO prepayment_tranches(trip_id, due_date, label, percent, sort_order)
    VALUES (t_f,'2027-06-01','Endzahlung',50,1) RETURNING id INTO trB;

  -- F2 zahlt Tranche 1 (150) — bestätigt (confirmed_at default now())
  INSERT INTO transactions(trip_id,type,date,description,amount,credit_from,credit_to,tranche_id)
    VALUES (t_f,'credit','2027-04-20','F2 Tranche1',150,pf2,pf1,trA);
  -- F3 meldet selbst (pending: confirmed_at = NULL)
  INSERT INTO transactions(trip_id,type,date,description,amount,credit_from,credit_to,tranche_id,confirmed_at)
    VALUES (t_f,'credit','2027-04-21','F3 Selbstmeldung',150,pf3,pf1,trA,NULL);

  SELECT coalesce(paid_amount,0) INTO v FROM v_prepayment_payments
    WHERE trip_id=t_f AND tranche_id=trA AND person_id=pf2;
  PERFORM pg_temp.chk('F Anzahlung: F2 bestätigt = 150', v, 150);
  SELECT coalesce(sum(paid_amount),0) INTO v FROM v_prepayment_payments
    WHERE trip_id=t_f AND tranche_id=trA AND person_id=pf3;
  PERFORM pg_temp.chk('F Anzahlung: F3 pending zählt NICHT als bezahlt = 0', v, 0);
  SELECT count(*) INTO cnt FROM v_prepayment_pending
    WHERE trip_id=t_f AND tranche_id=trA AND person_id=pf3;
  PERFORM pg_temp.chk_i('F Anzahlung: F3 in pending-View = 1', cnt, 1);
  SELECT count(*) INTO cnt FROM v_prepayment_pending
    WHERE trip_id=t_f AND person_id=pf2;
  PERFORM pg_temp.chk_i('F Anzahlung: bestätigte F2 NICHT in pending = 0', cnt, 0);
  -- Anzahlungs-Buchungen dürfen die Bordkasse-Bilanz NICHT beeinflussen
  SELECT count(*) INTO cnt FROM v_balances_bordkasse_only WHERE trip_id=t_f;
  PERFORM pg_temp.chk_i('F Anzahlung: tranche-getaggte Buchungen NICHT in Bordkasse-Bilanz', cnt, 0);

END $main$;

\echo ''
\echo '═══════════ FEHLGESCHLAGENE PRÜFUNGEN ═══════════'
SELECT name AS pruefung, got AS ist, want AS soll FROM _results WHERE NOT ok ORDER BY id;

\echo ''
\echo '═══════════ ZUSAMMENFASSUNG ═══════════'
SELECT count(*) AS total,
       count(*) FILTER (WHERE ok)     AS bestanden,
       count(*) FILTER (WHERE NOT ok) AS fehlgeschlagen
FROM _results;

-- Bei Fehlern: Transaktion mit Exception abbrechen (psql exit ≠ 0 dank ON_ERROR_STOP)
DO $$
DECLARE f int;
BEGIN
  SELECT count(*) INTO f FROM _results WHERE NOT ok;
  IF f > 0 THEN
    RAISE EXCEPTION '% Prüfung(en) FEHLGESCHLAGEN — Details siehe Tabelle oben.', f;
  END IF;
END $$;

ROLLBACK;
