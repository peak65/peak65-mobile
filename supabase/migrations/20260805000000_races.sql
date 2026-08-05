-- Run once in the Supabase SQL editor; idempotent via IF NOT EXISTS. Not auto-applied.

-- ─── 1. races table ──────────────────────────────────────────────────────────
-- One row per race an athlete is training for. An athlete has many races.
--
-- There is deliberately NO is_primary / is_focus column. The focus race is
-- always the soonest upcoming one, computed at read time:
--
--   SELECT * FROM races
--    WHERE user_id = $1 AND status = 'upcoming' AND race_date >= CURRENT_DATE
--    ORDER BY race_date
--    LIMIT 1;
--
-- A stored flag would silently go stale the moment a race date passes, with no
-- user action to hook a refresh onto. Computing it cannot drift.

CREATE TABLE IF NOT EXISTS races (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  race_date  DATE NOT NULL,
  event_name TEXT,
  event_city TEXT,
  division   TEXT,
  goal_time  TEXT,
  status     TEXT NOT NULL DEFAULT 'upcoming'
    CHECK (status IN ('upcoming', 'completed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every query is "this athlete's races, soonest first".
CREATE INDEX IF NOT EXISTS races_user_date_idx ON races (user_id, race_date);


-- ─── 2. Row level security ───────────────────────────────────────────────────
-- Two-sided access, modelled on the messages_participants policies: the athlete
-- who owns the row, OR that athlete's currently active coach. The usual
-- "auth.uid() = user_id" form would hide races from the coach, which defeats
-- the purpose — the coach plans the program around these dates and may enter
-- them on the athlete's behalf.
--
-- Every column inside the EXISTS is table-qualified on purpose: both races and
-- coach_athletes have a `status` column, so a bare `status = 'active'` reads as
-- ambiguous even though Postgres resolves it to the inner table.

ALTER TABLE races ENABLE ROW LEVEL SECURITY;

-- CREATE POLICY has no IF NOT EXISTS form, so drop first to keep this re-runnable.
DROP POLICY IF EXISTS "races_participants_select" ON races;
DROP POLICY IF EXISTS "races_participants_insert" ON races;
DROP POLICY IF EXISTS "races_participants_update" ON races;
DROP POLICY IF EXISTS "races_participants_delete" ON races;

CREATE POLICY "races_participants_select"
  ON races FOR SELECT
  USING (
    auth.uid() = races.user_id
    OR EXISTS (
      SELECT 1 FROM coach_athletes ca
      WHERE ca.athlete_id = races.user_id
        AND ca.coach_id   = auth.uid()
        AND ca.status     = 'active'
    )
  );

-- WITH CHECK only: INSERT has no pre-existing row to test with USING.
-- This is what stops anyone writing a race row against someone else's user_id.
CREATE POLICY "races_participants_insert"
  ON races FOR INSERT
  WITH CHECK (
    auth.uid() = races.user_id
    OR EXISTS (
      SELECT 1 FROM coach_athletes ca
      WHERE ca.athlete_id = races.user_id
        AND ca.coach_id   = auth.uid()
        AND ca.status     = 'active'
    )
  );

-- USING picks which rows may be targeted; WITH CHECK validates the row after
-- the update. Both are required — USING alone would let a permitted user
-- reassign user_id to an athlete they have no claim to.
CREATE POLICY "races_participants_update"
  ON races FOR UPDATE
  USING (
    auth.uid() = races.user_id
    OR EXISTS (
      SELECT 1 FROM coach_athletes ca
      WHERE ca.athlete_id = races.user_id
        AND ca.coach_id   = auth.uid()
        AND ca.status     = 'active'
    )
  )
  WITH CHECK (
    auth.uid() = races.user_id
    OR EXISTS (
      SELECT 1 FROM coach_athletes ca
      WHERE ca.athlete_id = races.user_id
        AND ca.coach_id   = auth.uid()
        AND ca.status     = 'active'
    )
  );

CREATE POLICY "races_participants_delete"
  ON races FOR DELETE
  USING (
    auth.uid() = races.user_id
    OR EXISTS (
      SELECT 1 FROM coach_athletes ca
      WHERE ca.athlete_id = races.user_id
        AND ca.coach_id   = auth.uid()
        AND ca.status     = 'active'
    )
  );
