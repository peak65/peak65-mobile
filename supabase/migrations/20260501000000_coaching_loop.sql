-- ─── Coaching loop tables ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS session_match_candidates (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  external_workout_id  TEXT NOT NULL,
  program_session_name TEXT,
  program_day_name     TEXT,
  program_week_number  INTEGER,
  program_id           UUID REFERENCES programs(id),
  status               TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'snoozed', 'dismissed')),
  snoozed_until        DATE,
  snooze_count         INTEGER NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at         TIMESTAMPTZ,
  UNIQUE (user_id, external_workout_id)
);

CREATE TABLE IF NOT EXISTS session_outcomes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id     UUID NOT NULL UNIQUE REFERENCES session_match_candidates(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  prescribed_zone  TEXT,
  confirmed_as     TEXT,
  is_substitution  BOOLEAN NOT NULL DEFAULT FALSE,
  actual_avg_hr    INTEGER,
  target_hr_low    INTEGER,
  target_hr_high   INTEGER,
  hr_vs_target     TEXT,
  rpe_logged       INTEGER,
  rpe_vs_target    TEXT,
  duration_minutes INTEGER,
  pace_per_km      TEXT,
  outcome_signal   TEXT CHECK (outcome_signal IN ('progress', 'hold', 'pullback', 'context_flag', 'substitution')),
  outcome_reason   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE programs ADD COLUMN IF NOT EXISTS generated_with_brief BOOLEAN DEFAULT FALSE;

-- RLS: users can only read/write their own rows
ALTER TABLE session_match_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_outcomes         ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users own candidates" ON session_match_candidates
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "users own outcomes" ON session_outcomes
  FOR ALL USING (auth.uid() = user_id);
