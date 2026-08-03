-- ═══════════════════════════════════════════════════════════════════════
-- 0045 — Skippern das eigenständige Anlegen von Törns erlauben
--
-- Bisher durften ausschließlich globale Admins (ADMIN_EMAILS-Env) einen
-- neuen Törn anlegen (createTrip, gated über requireAdmin). Ein Admin
-- soll künftig einzelnen Personen erlauben können, selbst Törns
-- anzulegen, ohne sie zum globalen Admin zu machen.
--
-- Einfacher Boolean auf persons, analog zu is_alcoholic — es gibt keine
-- separate Rollen-Tabelle. Schreibzugriff nur über eine admin-gegatete
-- Server Action (Service-Role-Client), daher kein RLS-Sonderfall nötig;
-- persons ist über persons_select_authenticated ohnehin für alle
-- authentifizierten Nutzer lesbar (0001_init.sql).
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE persons ADD COLUMN IF NOT EXISTS can_create_trips BOOLEAN NOT NULL DEFAULT FALSE;
