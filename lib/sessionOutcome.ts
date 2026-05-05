import { supabase } from './supabase';

// ─── Zone HR targets ──────────────────────────────────────────────────────────

const ZONE_HR_TARGETS: Record<string, { low: number; high: number }> = {
  threshold: { low: 151, high: 175 },
  tempo:     { low: 135, high: 155 },
  z2:        { low: 100, high: 145 },
  builder:   { low: 140, high: 175 },
};

function deriveZoneFromName(sessionName: string): string | null {
  const n = sessionName.toLowerCase();
  if (n.includes('threshold')) return 'threshold';
  if (n.includes('tempo'))     return 'tempo';
  if (n.includes('z2') || n.includes('zone 2') || n.includes('easy')) return 'z2';
  if (n.includes('builder') || n.includes('hyrox') || n.includes('station')) return 'builder';
  if (n.includes('strength') || n.includes('lift')) return 'strength';
  return null;
}

function computeHrStatus(
  avgHr: number | null,
  targetLow: number | null,
  targetHigh: number | null,
): 'on_target' | 'above' | 'below' | null {
  if (avgHr == null || targetLow == null || targetHigh == null) return null;
  if (avgHr > targetHigh + 5) return 'above';
  if (avgHr < targetLow - 5)  return 'below';
  return 'on_target';
}

function computeOutcomeSignal(params: {
  isSubstitution: boolean;
  prescribedZone: string | null;
  hrStatus: 'on_target' | 'above' | 'below' | null;
}): {
  signal: 'progress' | 'hold' | 'pullback' | 'context_flag' | 'substitution';
  reason: string;
} {
  if (params.isSubstitution) {
    return { signal: 'substitution', reason: 'User substituted a different session.' };
  }

  const { prescribedZone, hrStatus } = params;

  if (!hrStatus) {
    return { signal: 'hold', reason: 'No HR data to assess effort quality.' };
  }

  if (prescribedZone === 'z2') {
    if (hrStatus === 'above') return { signal: 'pullback', reason: 'HR above Z2 ceiling — went too hard on an easy day.' };
    return { signal: 'progress', reason: 'Z2 HR well controlled — good aerobic session.' };
  }

  if (prescribedZone === 'threshold' || prescribedZone === 'tempo' || prescribedZone === 'builder') {
    if (hrStatus === 'on_target') return { signal: 'progress', reason: 'HR on target — quality hard session.' };
    if (hrStatus === 'above')     return { signal: 'pullback', reason: 'HR significantly above target — reduce intensity next session.' };
    if (hrStatus === 'below')     return { signal: 'context_flag', reason: 'HR below target on a hard session — check readiness or perceived effort.' };
  }

  if (prescribedZone === 'strength') {
    return { signal: 'progress', reason: 'Strength session completed.' };
  }

  return { signal: 'hold', reason: 'Insufficient data to assess session quality.' };
}

// ─── calculateSessionOutcome ──────────────────────────────────────────────────

export async function calculateSessionOutcome(
  candidateId: string,
  isSubstitution: boolean = false,
): Promise<void> {
  const { data: candidate } = await supabase
    .from('session_match_candidates')
    .select('user_id, external_workout_id, program_session_name')
    .eq('id', candidateId)
    .maybeSingle();

  if (!candidate) return;

  const { data: workout } = await supabase
    .from('external_workouts')
    .select('avg_hr, duration_minutes, pace_per_km')
    .eq('id', candidate.external_workout_id)
    .maybeSingle();

  const sessionName    = candidate.program_session_name ?? '';
  const prescribedZone = deriveZoneFromName(sessionName);
  const zoneTarget     = prescribedZone ? (ZONE_HR_TARGETS[prescribedZone] ?? null) : null;

  const actualAvgHr = workout?.avg_hr ?? null;
  const targetLow   = zoneTarget?.low ?? null;
  const targetHigh  = zoneTarget?.high ?? null;
  const hrStatus    = computeHrStatus(actualAvgHr, targetLow, targetHigh);

  const { signal, reason } = computeOutcomeSignal({ isSubstitution, prescribedZone, hrStatus });

  const rawPace = workout?.pace_per_km as number | null ?? null;
  const pacePerKm = rawPace != null
    ? `${Math.floor(rawPace / 60)}:${Math.round(rawPace % 60).toString().padStart(2, '0')}`
    : null;

  await supabase.from('session_outcomes').upsert({
    candidate_id:     candidateId,
    user_id:          candidate.user_id,
    prescribed_zone:  prescribedZone,
    confirmed_as:     sessionName,
    is_substitution:  isSubstitution,
    actual_avg_hr:    actualAvgHr,
    target_hr_low:    targetLow,
    target_hr_high:   targetHigh,
    hr_vs_target:     hrStatus,
    rpe_logged:       null,
    rpe_vs_target:    null,
    duration_minutes: workout?.duration_minutes ?? null,
    pace_per_km:      pacePerKm,
    outcome_signal:   signal,
    outcome_reason:   reason,
  }, { onConflict: 'candidate_id' });

  console.log('[sessionOutcome]', candidateId, '->', signal, '|', reason);
}
