-- 0057: Anzahlungs-Sollbeträge für die ganze Crew lesbar machen
--
-- `prepayment_obligations` war die einzige Anzahlungs-Tabelle, deren
-- SELECT-Policy nicht auf Mitgliedschaft, sondern auf „Skipper ODER eigene
-- Zeile" stand (0023). Die drei Schwestertabellen sind alle member-lesbar:
--
--   prepayment_plan      pp_select_member   is_trip_member OR is_trip_skipper
--   prepayment_tranches  tr_select_member   is_trip_member OR is_trip_skipper
--   cabin_types          ct_select_member   is_trip_member OR is_trip_skipper
--   prepayment_obligations  po_select_self_or_skipper  ← der Ausreißer
--
-- Folge im Betrieb (vom Skipper gemeldet): die Bilanz-Seite zeigt den
-- Anzahlungs-Pool ungegatet JEDEM Crewmitglied (app/trips/[id]/balance/
-- page.tsx, Block „Crewbeiträge"). Das „bezahlt"-Ist kommt aus
-- `transactions` (member-lesbar), das Soll aus dieser Tabelle — für ein
-- normales Crewmitglied lieferte RLS also nur die EIGENE Soll-Zeile, alle
-- anderen kamen als `soll = 0` an. Und weil die Statuslogik dort
-- `soll <= 0.005 → "paid"` sagt, stand bei jedem anderen Crewmitglied ein
-- grünes „bezahlt"-Häkchen neben „471,29 € / 0,00 €": nicht bloß eine Lücke,
-- sondern eine inhaltlich FALSCHE Aussage (alle wirken schuldenfrei).
--
-- Zweiter, unabhängiger Treffer derselben Lücke: ein Vorstrecker, der nicht
-- Trip-Skipper ist, darf die Matrix laut App-Layer verwalten
-- (`requireSkipperAdminOrAdvancer` in lib/auth/authz.ts, `canManage` in
-- prepayments/page.tsx) — bekam über RLS aber ebenfalls nur seine eigene
-- Soll-Zeile zu sehen.
--
-- Entscheidung (mit dem Skipper abgestimmt): Transparenz. Wer wie viel zur
-- Anzahlung beisteuert, ist dieselbe Klasse geteilter Kassendaten wie die
-- Bilanz, die ohnehin jedes Crewmitglied für die ganze Crew sieht
-- (`v_balances`). Die Alternative — Fremdzeilen in der UI ausblenden — wäre
-- inkonsistent zur Bordkasse und würde die Fairness-Kontrolle nehmen.
--
-- Die Self-Klausel bleibt zusätzlich erhalten: eine Person, die ein
-- Anzahlungs-Soll hat, aber (z. B. nach einem Crew-Wechsel) nicht mehr in
-- `trip_members` steht, soll ihre eigene Zeile weiterhin sehen können.
-- Schreibrechte bleiben unangetastet (0050 hat die Write-Policies entfernt;
-- geschrieben wird ausschließlich über den Service-Role-Client).

-- Beide Namen droppen: der alte (0023) UND der neue — sonst wäre ein zweiter
-- Lauf ein `42710 policy already exists`. Relevant, weil Migrationen hier auch
-- manuell per `wget … | psql` eingespielt werden (siehe CLAUDE.md) und dabei
-- der Ledger-Eintrag vergessen werden kann.
DROP POLICY IF EXISTS "po_select_self_or_skipper" ON prepayment_obligations;
DROP POLICY IF EXISTS "po_select_member" ON prepayment_obligations;

CREATE POLICY "po_select_member"
  ON prepayment_obligations FOR SELECT TO authenticated
  USING (
    is_trip_member(trip_id)
    OR is_trip_skipper(trip_id)
    OR person_id = current_person_id()
  );
