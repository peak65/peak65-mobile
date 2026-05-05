-- ─── 1. coaches table ────────────────────────────────────────────────────────
-- One row per coach. The mobile app checks this table to decide whether to
-- show the Coach tab. Run once; idempotent via IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS coaches (
  id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE coaches ENABLE ROW LEVEL SECURITY;

-- Coaches can only read their own row (used for the tab visibility check)
CREATE POLICY "coaches_read_own"
  ON coaches FOR SELECT
  USING (auth.uid() = id);


-- ─── 2. notes column on coach_athletes ───────────────────────────────────────
-- Private coach notes per athlete. Visible only to the coach.

ALTER TABLE coach_athletes ADD COLUMN IF NOT EXISTS notes text;


-- ─── 3. messages table ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS messages (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  athlete_id uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sender_id  uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body       text        NOT NULL,
  created_at timestamptz DEFAULT now(),
  read_at    timestamptz
);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "messages_participants_select"
  ON messages FOR SELECT
  USING (auth.uid() = coach_id OR auth.uid() = athlete_id);

CREATE POLICY "messages_participants_insert"
  ON messages FOR INSERT
  WITH CHECK (
    auth.uid() = sender_id
    AND (auth.uid() = coach_id OR auth.uid() = athlete_id)
  );

CREATE POLICY "messages_participants_update"
  ON messages FOR UPDATE
  USING (auth.uid() = coach_id OR auth.uid() = athlete_id);

CREATE INDEX IF NOT EXISTS messages_thread_idx
  ON messages (coach_id, athlete_id, created_at);


-- ─── 4. Add Dakota as a coach ─────────────────────────────────────────────────
-- Uncomment and run after confirming his UUID, or run as-is to auto-resolve:

INSERT INTO coaches (id)
SELECT id FROM auth.users WHERE email = 'dakota@emeraldcityathletics.com'
ON CONFLICT (id) DO NOTHING;
