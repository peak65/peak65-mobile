import { useEffect, useState } from 'react';
import { supabase } from './supabase';

export const FALLBACK_COACH_NAME = 'Your coach';

// Resolves the signed-in athlete's coach: coach_athletes → coach_id → profiles.
// Two round-trips, so it only runs when `enabled` — screens shared with
// non-coached athletes pass false and pay nothing.
//
// Any failure (no link row, no name, network) leaves the generic fallback in
// place rather than naming the wrong person.
export function useCoachName(enabled: boolean = true): string {
  const [coachName, setCoachName] = useState(FALLBACK_COACH_NAME);

  useEffect(() => {
    if (!enabled) return;
    let active = true;

    async function loadCoach() {
      const { data: { session } } = await supabase.auth.getSession();
      const uid = session?.user?.id;
      if (!uid) return;

      const { data: ca } = await supabase
        .from('coach_athletes')
        .select('coach_id')
        .eq('athlete_id', uid)
        .eq('status', 'active')
        .maybeSingle();
      if (!ca?.coach_id) return;

      const { data: p } = await supabase
        .from('profiles')
        .select('first_name, last_name')
        .eq('id', ca.coach_id)
        .maybeSingle();

      const firstName = (p?.first_name ?? '').trim();
      if (active && firstName) setCoachName(firstName);
    }

    loadCoach().catch(() => {});
    return () => { active = false; };
  }, [enabled]);

  return coachName;
}
