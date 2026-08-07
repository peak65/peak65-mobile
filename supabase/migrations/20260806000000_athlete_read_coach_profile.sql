-- Run once in the Supabase SQL editor; idempotent. Not auto-applied.
-- Lets an athlete read ONLY their own active coach's profile row (mirror of the existing "Coaches can view their athletes profiles" policy). Enables the app to show the coach's name.

DROP POLICY IF EXISTS "Athletes can view their coach profile" ON profiles;

CREATE POLICY "Athletes can view their coach profile"
  ON profiles FOR SELECT
  USING (
    id IN (
      SELECT coach_athletes.coach_id
      FROM coach_athletes
      WHERE coach_athletes.athlete_id = auth.uid()
        AND coach_athletes.status = 'active'
    )
  );
