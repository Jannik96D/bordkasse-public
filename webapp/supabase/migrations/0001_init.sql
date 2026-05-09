-- ═══════════════════════════════════════════════════════════════════════
-- 0001_init — Initial Schema
-- Tabellen + ENUMs für Bordkasse-Datenmodell.
-- Spec: docs/web-app-spec.md §Datenmodell
-- ═══════════════════════════════════════════════════════════════════════

-- ── ENUMs ──────────────────────────────────────────────────────────────
CREATE TYPE transaction_type AS ENUM ('expense', 'credit');
CREATE TYPE split_type AS ENUM ('equal', 'on_board', 'time_proportional', 'individual');


-- ── persons ────────────────────────────────────────────────────────────
-- Ein Crew-Mitglied. Optionaler Link auf auth.users via auth_user_id —
-- das erlaubt "Ghost-Personen" (von Skipper eingeladen, aber noch nicht
-- selbst eingeloggt). Beim ersten Login wird auth_user_id automatisch
-- nachgetragen (siehe lib/auth/get-current-person.ts).
CREATE TABLE persons (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id    UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  display_name    TEXT NOT NULL,
  email           TEXT UNIQUE,
  is_alcoholic    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_persons_auth_user_id ON persons(auth_user_id);
CREATE INDEX idx_persons_email_lower ON persons(LOWER(email));


-- ── trips ──────────────────────────────────────────────────────────────
CREATE TABLE trips (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  start_date      DATE NOT NULL,
  end_date        DATE NOT NULL,
  ship_name       TEXT,
  skipper_id      UUID NOT NULL REFERENCES persons(id),
  archived        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT trips_dates_chk CHECK (end_date >= start_date)
);

CREATE INDEX idx_trips_skipper ON trips(skipper_id);


-- ── trip_members ───────────────────────────────────────────────────────
-- Crew pro Törn mit partieller Anwesenheit.
-- on_board_from / on_board_to NULL = ab Törn-Start / bis Törn-Ende.
CREATE TABLE trip_members (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id         UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  person_id       UUID NOT NULL REFERENCES persons(id),
  on_board_from   DATE,
  on_board_to     DATE,
  is_alcoholic    BOOLEAN,    -- Override; NULL = persons.is_alcoholic übernehmen
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(trip_id, person_id),
  CONSTRAINT tm_dates_chk CHECK (
    on_board_from IS NULL OR on_board_to IS NULL OR on_board_to >= on_board_from
  )
);

CREATE INDEX idx_trip_members_trip ON trip_members(trip_id);
CREATE INDEX idx_trip_members_person ON trip_members(person_id);


-- ── trip_categories ────────────────────────────────────────────────────
CREATE TABLE trip_categories (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id         UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  hint            TEXT,
  sort_order      INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(trip_id, name)
);

CREATE INDEX idx_trip_categories_trip ON trip_categories(trip_id);


-- ── transactions ───────────────────────────────────────────────────────
-- Eine Transaktion ist entweder Ausgabe (type='expense') oder Gutschrift
-- (type='credit'). Felder sind je nach Typ relevant.
CREATE TABLE transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id         UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  type            transaction_type NOT NULL,
  date            DATE NOT NULL,
  description     TEXT,

  amount          NUMERIC(10,2) NOT NULL,
  alcohol_amount  NUMERIC(10,2) NOT NULL DEFAULT 0,

  -- Bei type='expense':
  paid_by         UUID REFERENCES persons(id),
  category_id     UUID REFERENCES trip_categories(id) ON DELETE SET NULL,
  split_type      split_type,

  -- Bei type='credit':
  credit_from     UUID REFERENCES persons(id),
  credit_to       UUID REFERENCES persons(id),  -- NULL = "Alle"

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID REFERENCES persons(id),

  -- Geschäftsregeln
  CONSTRAINT tx_amount_pos        CHECK (amount > 0),
  CONSTRAINT tx_alc_lte_amount    CHECK (alcohol_amount >= 0 AND alcohol_amount <= amount),
  CONSTRAINT tx_expense_fields    CHECK (
    type <> 'expense' OR (paid_by IS NOT NULL AND split_type IS NOT NULL)
  ),
  CONSTRAINT tx_credit_fields     CHECK (
    type <> 'credit' OR (credit_from IS NOT NULL)
  ),
  CONSTRAINT tx_credit_self       CHECK (
    type <> 'credit' OR credit_to IS NULL OR credit_to <> credit_from
  )
);

CREATE INDEX idx_transactions_trip ON transactions(trip_id);
CREATE INDEX idx_transactions_trip_date ON transactions(trip_id, date);
CREATE INDEX idx_transactions_paid_by ON transactions(paid_by);
CREATE INDEX idx_transactions_credit_from ON transactions(credit_from);
CREATE INDEX idx_transactions_credit_to ON transactions(credit_to);


-- ── transaction_participants ───────────────────────────────────────────
-- Nur befüllt für split_type='individual': welche Personen sind dabei.
CREATE TABLE transaction_participants (
  transaction_id  UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  person_id       UUID NOT NULL REFERENCES persons(id),
  PRIMARY KEY (transaction_id, person_id)
);

CREATE INDEX idx_tx_participants_person ON transaction_participants(person_id);
