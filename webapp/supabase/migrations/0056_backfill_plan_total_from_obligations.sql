-- 0056: Einmal-Reparatur — Anzahlungs-Gesamtsumme 0 aus den Sollbeträgen füllen
--
-- Bei den Aufteilungen „individuell" und „kojen" durfte die „Gesamtsumme der
-- Anzahlung" im Wizard leer bleiben (`needsTotalAmount` prüfte nur
-- `gleichmaessig`/`zeitanteilig`) — das Soll kommt dort aus Einzel- bzw.
-- Kojenpreisen. `prepayment_plan.total_amount` ist aber gleichzeitig das
-- CHARTER-Soll (was der Vorstrecker dem Vercharterer schuldet). Die leere
-- Eingabe landete als 0, und damit rechneten mit 0:
--
--   * Tranchen-Vorbelegung im Buchungsformular → Betrag 0,00 € statt
--     `total_amount × percent / 100` (der eigentliche Grund für „die
--     Vorbelegung der Yachtanzahlung funktioniert nicht"; weil „0,00" auch
--     der Platzhalter des Betragsfelds ist, war sie nicht mal erkennbar).
--   * Charter-Reminder-Banner + Fortschritts-Prozent in der Matrix → 0 €.
--   * `advancerOwes` in getPrepaymentNavState → hielt die Anzahlung für
--     vollständig überwiesen (steuert u. a. das Tranchen-Feld).
--   * Vorstrecker-Erinnerung (`advancer_3d`) → fiel aus demselben Grund aus.
--
-- Für NEUE/geänderte Pläne ist die Gesamtsumme jetzt Pflicht (Zod-Refine in
-- `lib/validation/prepayment-schema.ts` + Gate im Wizard, der bei
-- „individuell"/„kojen" einen „Σ Soll übernehmen"-Button anbietet). Bewusst
-- KEINE dauerhafte Ableitung im Schreibpfad: nach dem ersten Speichern wäre
-- „abgeleitet" nicht mehr von „so gewollt" unterscheidbar, und eine später
-- geänderte Koje bzw. Einzelsumme liefe still von der Plansumme weg.
--
-- Diese Migration ist deshalb eine EINMAL-REPARATUR der Bestandsdaten: Σ Soll
-- ist die beste verfügbare Schätzung (bei „individuell"/„kojen" genau der
-- Betrag, der bei der Crew eingesammelt wird). Ist das echte Charter-Soll
-- höher (Differenz läuft laut Spec über die Bordkasse), korrigiert der
-- Skipper es im Wizard — die dortige Σ-Abgleich-Warnung zeigt die Abweichung
-- jetzt an, was sie bei total_amount = 0 nie tat (sie verlangt > 0).
--
-- Nur Pläne mit total_amount = 0 werden angefasst. Für
-- „gleichmaessig"/„zeitanteilig" ist der Fall ohnehin ausgeschlossen: dort
-- blockte der Wizard schon immer eine Summe von 0, und deren Sollbeträge
-- werden aus der Summe berechnet (Σ wäre also ebenfalls 0 → kein Treffer).

UPDATE prepayment_plan p
SET total_amount = sub.soll_sum
FROM (
  SELECT trip_id, SUM(total_amount) AS soll_sum
  FROM prepayment_obligations
  GROUP BY trip_id
) sub
WHERE sub.trip_id = p.trip_id
  AND p.total_amount = 0
  AND sub.soll_sum > 0;
