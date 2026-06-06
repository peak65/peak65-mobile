import { supabase } from './supabase';
import { calculateSessionOutcome } from './sessionOutcome';

// ─── Types ────────────────────────────────────────────────────────────────────

export type CandidateStatus = 'pending' | 'confirmed' | 'snoozed' | 'dismissed';

export type CandidateRow = {
  id: string;
  user_id: string;
  external_workout_id: string;
  program_session_name: string | null;
  program_day_name: string | null;
  program_week_number: number | null;
  program_id: string | null;
  status: CandidateStatus;
  snoozed_until: string | null;
  snooze_count: number;
  created_at: string;
  confirmed_at: string | null;
  // Joined from external_workouts
  workout_type: string | null;
  duration_minutes: number | null;
  source: string | null;
  avg_hr: number | null;
  start_time: string | null;
};

// ─── Workout-to-session type compatibility ─────────────────────────────────────

function matchesSessionType(sessionName: string, workoutType: string): boolean {
  const n = sessionName.toLowerCase();
  const t = workoutType.toLowerCase();
  switch (t) {
    case 'run':
      return n.includes('run') || n.includes('threshold') || n.includes('tempo')
          || n.includes('z2') || n.includes('zone 2') || n.includes('easy');
    case 'strength':
      return n.includes('strength') || n.includes('lift') || n.includes('squat')
          || n.includes('deadlift') || n.includes('press');
    case 'row':
      return n.includes('row') || n.includes('erg');
    case 'bike':
      return n.includes('bike') || n.includes('cycle') || n.includes('z2')
          || n.includes('easy') || n.includes('zone 2');
    case 'hiit':
      return n.includes('hiit') || n.includes('builder') || n.includes('circuit')
          || n.includes('station');
    case 'walk':
    case 'hike':
      return n.includes('z2') || n.includes('easy') || n.includes('recovery')
          || n.includes('walk') || n.includes('hike');
    default:
      return true; // swim, yoga, other — match anything
  }
}

// ─── detectCandidates — call on app open ─────────────────────────────────────
// Finds today's unmatched external workouts, tries to pair each with a program
// session, and creates pending rows in session_match_candidates.
// Safe to call multiple times — UNIQUE constraint prevents duplicates.

export async function detectCandidates(userId: string): Promise<void> {
  const today     = new Date().toLocaleDateString('en-CA');
  const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });

  // Find the active program for this week
  const { data: programs } = await supabase
    .from('programs')
    .select('id, week_number, week_start_date, program_data')
    .eq('user_id', userId)
    .not('is_draft', 'is', true)
    .order('week_number', { ascending: false })
    .limit(5);

  let activeProgramId: string | null = null;
  let weekNumber: number | null      = null;
  let todaySessions: Array<{ name: string; duration_minutes: number }> = [];

  for (const prog of programs ?? []) {
    const start = new Date(prog.week_start_date + 'T00:00:00');
    const end   = new Date(start.getTime() + 7 * 86_400_000);
    if (new Date() >= start && new Date() < end) {
      activeProgramId = prog.id;
      weekNumber      = prog.week_number;
      const days: any[] = prog.program_data?.days ?? [];
      const todayDay    = days.find((d: any) => d.day === todayName);
      todaySessions = (todayDay?.sessions ?? []).map((s: any) => ({
        name:             s.name ?? '',
        duration_minutes: s.duration_minutes ?? 60,
      }));
      break;
    }
  }

  if (!activeProgramId || todaySessions.length === 0) return;

  // Fetch today's external workouts (>= 10 min to filter noise)
  const todayStart = today + 'T00:00:00.000Z';
  const todayEnd   = today + 'T23:59:59.999Z';
  const { data: workouts } = await supabase
    .from('external_workouts')
    .select('id, workout_type, duration_minutes, source, avg_hr, start_time')
    .eq('user_id', userId)
    .gte('start_time', todayStart)
    .lte('start_time', todayEnd)
    .gte('duration_minutes', 10);

  if (!workouts?.length) return;

  // Skip workouts already in session_match_candidates
  const workoutIds = workouts.map(w => w.id as string);
  const { data: existing } = await supabase
    .from('session_match_candidates')
    .select('external_workout_id')
    .eq('user_id', userId)
    .in('external_workout_id', workoutIds);

  const existingSet = new Set((existing ?? []).map(e => e.external_workout_id as string));

  const rows: object[] = [];

  for (const w of workouts) {
    if (existingSet.has(w.id as string)) continue;

    let bestSession: { name: string; duration_minutes: number } | null = null;
    let bestDiff = Infinity;

    for (const s of todaySessions) {
      if (!matchesSessionType(s.name, (w.workout_type as string) ?? '')) continue;
      const diff = Math.abs((w.duration_minutes as number) - s.duration_minutes);
      if (diff <= 25 && diff < bestDiff) {
        bestDiff    = diff;
        bestSession = s;
      }
    }

    if (!bestSession) continue;

    rows.push({
      user_id:              userId,
      external_workout_id:  w.id,
      program_session_name: bestSession.name,
      program_day_name:     todayName,
      program_week_number:  weekNumber,
      program_id:           activeProgramId,
      status:               'pending',
    });
  }

  if (!rows.length) return;

  await supabase.from('session_match_candidates').upsert(rows, {
    onConflict:       'user_id,external_workout_id',
    ignoreDuplicates: true,
  });
  console.log('[sessionMatcher] created', rows.length, 'candidate(s)');
}

// ─── getPendingCandidates ─────────────────────────────────────────────────────
// Applies auto-dismiss / re-surface logic, then returns pending rows with
// joined workout details.

export async function getPendingCandidates(userId: string): Promise<CandidateRow[]> {
  const today       = new Date().toLocaleDateString('en-CA');
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();

  // Auto-dismiss old candidates (> 3 days)
  await supabase
    .from('session_match_candidates')
    .update({ status: 'dismissed' })
    .eq('user_id', userId)
    .in('status', ['pending', 'snoozed'])
    .lt('created_at', threeDaysAgo);

  // Dismiss snoozed candidates that have been snoozed 3+ times
  await supabase
    .from('session_match_candidates')
    .update({ status: 'dismissed' })
    .eq('user_id', userId)
    .eq('status', 'snoozed')
    .gte('snooze_count', 3);

  // Re-surface snoozed candidates whose snooze window has passed
  await supabase
    .from('session_match_candidates')
    .update({ status: 'pending' })
    .eq('user_id', userId)
    .eq('status', 'snoozed')
    .lte('snoozed_until', today);

  const { data: candidates } = await supabase
    .from('session_match_candidates')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (!candidates?.length) return [];

  // Join with external_workouts for display data
  const workoutIds = candidates.map(c => c.external_workout_id as string);
  const { data: workouts } = await supabase
    .from('external_workouts')
    .select('id, workout_type, duration_minutes, source, avg_hr, start_time')
    .in('id', workoutIds);

  const workoutMap = new Map((workouts ?? []).map(w => [w.id as string, w]));

  return candidates.map(c => ({
    ...c,
    workout_type:     (workoutMap.get(c.external_workout_id as string) as any)?.workout_type ?? null,
    duration_minutes: (workoutMap.get(c.external_workout_id as string) as any)?.duration_minutes ?? null,
    source:           (workoutMap.get(c.external_workout_id as string) as any)?.source ?? null,
    avg_hr:           (workoutMap.get(c.external_workout_id as string) as any)?.avg_hr ?? null,
    start_time:       (workoutMap.get(c.external_workout_id as string) as any)?.start_time ?? null,
  })) as CandidateRow[];
}

// ─── snoozeCandidate ──────────────────────────────────────────────────────────

export async function snoozeCandidate(candidateId: string): Promise<void> {
  const { data: candidate } = await supabase
    .from('session_match_candidates')
    .select('snooze_count')
    .eq('id', candidateId)
    .maybeSingle();

  const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA');
  await supabase
    .from('session_match_candidates')
    .update({
      status:        'snoozed',
      snoozed_until: tomorrow,
      snooze_count:  ((candidate?.snooze_count as number) ?? 0) + 1,
    })
    .eq('id', candidateId);
}

// ─── confirmMatch ─────────────────────────────────────────────────────────────
// Marks candidate confirmed and asynchronously calculates the session outcome.

export async function confirmMatch(
  candidateId: string,
  confirmedSessionName?: string,
): Promise<void> {
  const { data: candidate } = await supabase
    .from('session_match_candidates')
    .select('program_session_name')
    .eq('id', candidateId)
    .maybeSingle();

  const isSubstitution =
    !!confirmedSessionName &&
    confirmedSessionName !== (candidate?.program_session_name as string | null);

  const update: Record<string, unknown> = {
    status:       'confirmed',
    confirmed_at: new Date().toISOString(),
  };
  if (confirmedSessionName) update.program_session_name = confirmedSessionName;

  await supabase
    .from('session_match_candidates')
    .update(update)
    .eq('id', candidateId);

  calculateSessionOutcome(candidateId, isSubstitution).catch(e =>
    console.log('[sessionMatcher] outcome calc error:', e),
  );
}
