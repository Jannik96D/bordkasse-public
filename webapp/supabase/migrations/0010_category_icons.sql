-- ═══════════════════════════════════════════════════════════════════════
-- 0010_category_icons — Emoji-Icons pro Kategorie
--
-- Speichert pro Kategorie ein Emoji als optisches Erkennungsmerkmal.
-- Wir nutzen Emojis (statt SVG-Icons), weil sie nativ in HTML-<select>
-- gerendert werden und kein extra UI-Code für ein Custom-Dropdown nötig ist.
--
-- Bestandsdaten: bekannte Default-Namen werden auf vordefinierte Emojis
-- gemappt. Eigene Kategorien-Namen bleiben ohne Icon (NULL) und können
-- via UI nachträglich gesetzt werden.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE trip_categories
  ADD COLUMN IF NOT EXISTS icon TEXT;

UPDATE trip_categories SET icon = '🛒'  WHERE name = 'Lebensmittel'        AND icon IS NULL;
UPDATE trip_categories SET icon = '🍽️'  WHERE name = 'Restaurant'          AND icon IS NULL;
UPDATE trip_categories SET icon = '⛽'  WHERE name = 'Sprit'                AND icon IS NULL;
UPDATE trip_categories SET icon = '⛵'  WHERE name = 'Yacht'                AND icon IS NULL;
UPDATE trip_categories SET icon = '⚓'  WHERE name = 'Hafen / Liegeplatz'   AND icon IS NULL;
UPDATE trip_categories SET icon = '🛠️'  WHERE name = 'Ausrüstung'          AND icon IS NULL;
UPDATE trip_categories SET icon = '🛡️'  WHERE name = 'Versicherung'         AND icon IS NULL;
UPDATE trip_categories SET icon = '📦'  WHERE name = 'Sonstiges'            AND icon IS NULL;
