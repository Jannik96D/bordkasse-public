-- ═══════════════════════════════════════════════════════════════════════
-- 0012_category_icons_lucide — Emoji-Icons → lucide-react-Namen
--
-- Wir wechseln von Emojis auf lucide-react-Komponenten, weil Emojis als
-- Color-Glyphen gerendert werden und nicht in --navy einfärbbar sind.
-- Lucide-Icons sind monochrome SVGs, die sich konsistent zum Bottom-Nav-
-- Stil ins Marineblau einfügen (siehe docs/design-system.md).
--
-- Bestehende `icon`-Spalte bleibt TEXT — wir mappen die Werte um.
-- Whitelist gültiger Icon-Namen lebt im Frontend (lib/categories/icons.ts);
-- die DB speichert weiterhin den String. Unbekannte Werte fallen zur
-- Render-Zeit auf "Tag" als Default zurück.
-- ═══════════════════════════════════════════════════════════════════════

UPDATE trip_categories SET icon = 'ShoppingCart'  WHERE icon = '🛒';
UPDATE trip_categories SET icon = 'Utensils'      WHERE icon = '🍽️';
UPDATE trip_categories SET icon = 'Coffee'        WHERE icon = '☕';
UPDATE trip_categories SET icon = 'Beer'          WHERE icon = '🍺';
UPDATE trip_categories SET icon = 'Wine'          WHERE icon = '🍷';
UPDATE trip_categories SET icon = 'Pizza'         WHERE icon = '🍕';
UPDATE trip_categories SET icon = 'CakeSlice'     WHERE icon = '🍰';
UPDATE trip_categories SET icon = 'Fuel'          WHERE icon = '⛽';
UPDATE trip_categories SET icon = 'Sailboat'      WHERE icon = '⛵';
UPDATE trip_categories SET icon = 'Anchor'        WHERE icon = '⚓';
UPDATE trip_categories SET icon = 'Wrench'        WHERE icon = '🛠️';
UPDATE trip_categories SET icon = 'Hammer'        WHERE icon = '🧰';
UPDATE trip_categories SET icon = 'ShieldCheck'   WHERE icon = '🛡️';
UPDATE trip_categories SET icon = 'Ticket'        WHERE icon = '🎫';
UPDATE trip_categories SET icon = 'Bus'           WHERE icon = '🚌';
UPDATE trip_categories SET icon = 'SquareParking' WHERE icon = '🅿️';
UPDATE trip_categories SET icon = 'Pill'          WHERE icon = '💊';
UPDATE trip_categories SET icon = 'SprayCan'      WHERE icon = '🧴';
UPDATE trip_categories SET icon = 'Gift'          WHERE icon = '🎁';
UPDATE trip_categories SET icon = 'PartyPopper'   WHERE icon = '🎉';
UPDATE trip_categories SET icon = 'Package'       WHERE icon = '📦';
UPDATE trip_categories SET icon = 'Banknote'      WHERE icon = '💸';
