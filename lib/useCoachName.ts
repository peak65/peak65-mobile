import { useEffect, useState } from 'react';
import { supabase } from './supabase';

export const FALLBACK_COACH_NAME = 'Your coach';

export type CoachNameState = {
  /** Coach's first name, or FALLBACK_COACH_NAME if it could not be resolved. */
  name: string;
  /** False until the lookup has finished. Callers should wait rather than
   *  render the fallback and swap it for the real name a moment later. */
  resolved: boolean;
};

// Resolves the signed-in athlete's coach: coach_athletes → coach_id → profiles.
// Two round-trips, so it only runs when `enabled` — screens shared with
// non-coached athletes pass false and pay nothing.
//
// Every failure path is logged: previously these were swallowed, which made a
// missing coach link indistinguishable from an RLS denial or an empty name.
export function useCoachName(enabled: boolean = true): CoachNameState {
  const [name, setName]         = useState(FALLBACK_COACH_NAME);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    // Nothing to wait for when disabled — report resolved so callers that gate
    // rendering on it don't hang.
    if (!enabled) { setResolved(true); return; }

    let active = true;

    async function loadCoach() {
      const { data: { session } } = await supabase.auth.getSession();
      const uid = session?.user?.id;
      if (!uid) { console.log('[useCoachName] no session'); return; }

      const { data: ca, error: caErr } = await supabase
        .from('coach_athletes')
        .select('coach_id')
        .eq('athlete_id', uid)
        .eq('status', 'active')
        .maybeSingle();

      if (caErr) { console.log('[useCoachName] coach_athletes error:', caErr.message); return; }
      if (!ca?.coach_id) {
        console.log('[useCoachName] no active coach_athletes row for athlete', uid);
        return;
      }

      const { data: p, error: pErr } = await supabase
        .from('profiles')
        .select('first_name, last_name')
        .eq('id', ca.coach_id)
        .maybeSingle();

      if (pErr) { console.log('[useCoachName] coach profile error:', pErr.message); return; }
      if (!p) {
        console.log('[useCoachName] coach profile not readable for coach_id', ca.coach_id);
        return;
      }

      const firstName = (p.first_name ?? '').trim();
      if (!firstName) { console.log('[useCoachName] coach profile has empty first_name'); return; }

      if (active) setName(firstName);
    }

    loadCoach()
      .catch(err => console.log('[useCoachName] error:', err))
      .finally(() => { if (active) setResolved(true); });

    return () => { active = false; };
  }, [enabled]);

  return { name, resolved };
}
