import { supabase } from './supabase';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SessionSignal   = 'progress' | 'hold' | 'pullback' | 'context_flag' | 'substitution';
export type FatigueLevel    = 'fresh' | 'normal' | 'accumulated' | 'critical';
export type AdaptationSignal = 'progress' | 'hold' | 'pullback';

export type AdaptationBrief = {
  threshold_run:    AdaptationSignal | null;
  tempo_run:        AdaptationSignal | null;
  z2:               AdaptationSignal | null;
  strength:         AdaptationSignal | null;
  station_work:     AdaptationSignal | null;
  overall_fatigue:  FatigueLevel;
  peak_score_trend: 'rising' | 'stable' | 'declining' | null;
  notes:            string[];
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Category = 'threshold_run' | 'tempo_run' | 'z2' | 'strength' | 'station_work';

function sessionCategory(sessionName: string): Category | null {
  const n = sessionName.toLowerCase();
  if (n.includes('threshold'))                              return 'threshold_run';
  if (n.includes('tempo'))                                  return 'tempo_run';
  if (n.includes('z2') || n.includes('zone 2') || n.includes('easy')) return 'z2';
  if (n.includes('strength') || n.includes('lift'))         return 'strength';
  if (n.includes('builder') || n.includes('hyrox') || n.includes('station')) return 'station_work';
  return null;
}

function signalToAdaptation(signal: SessionSignal): AdaptationSignal {
  if (signal === 'pullback') return 'pullback';
  if (signal === 'progress') return 'progress';
  return 'hold';
}

function averageOf(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// ─── buildAdaptationBrief ─────────────────────────────────────────────────────

export async function buildAdaptationBrief(userId: string): Promise<AdaptationBrief> {
  const sevenDaysAgo   = new Date(Date.now() - 7  * 86_400_000).toISOString().slice(0, 10);
  const threeWeeksAgo  = new Date(Date.now() - 21 * 86_400_000).toISOString();

  const [scoresRes, outcomesRes] = await Promise.all([
    supabase
      .from('peak_scores')
      .select('score_date, score')
      .eq('user_id', userId)
      .gte('score_date', sevenDaysAgo)
      .order('score_date', { ascending: true }),
    supabase
      .from('session_outcomes')
      .select('outcome_signal, confirmed_as, created_at')
      .eq('user_id', userId)
      .gte('created_at', threeWeeksAgo)
      .order('created_at', { ascending: true }),
  ]);

  const scores   = (scoresRes.data   ?? []) as { score_date: string; score: number }[];
  const outcomes = (outcomesRes.data ?? []) as { outcome_signal: string; confirmed_as: string; created_at: string }[];

  // ── Overall fatigue ───────────────────────────────────────────────────────────
  const scoreNums   = scores.map(s => s.score);
  const avgScore    = averageOf(scoreNums);
  const pullbackCount = outcomes.filter(o => o.outcome_signal === 'pullback').length;

  let overall_fatigue: FatigueLevel;
  if (avgScore == null)               overall_fatigue = 'normal';
  else if (avgScore >= 70)            overall_fatigue = 'fresh';
  else if (avgScore >= 50)            overall_fatigue = 'normal';
  else if (avgScore >= 35 && pullbackCount < 3) overall_fatigue = 'accumulated';
  else                                overall_fatigue = 'critical';

  // Critical override: 3+ pullback signals this period regardless of score
  if (pullbackCount >= 3) overall_fatigue = 'critical';

  // ── Peak score trend ──────────────────────────────────────────────────────────
  let peak_score_trend: 'rising' | 'stable' | 'declining' | null = null;
  if (scoreNums.length >= 4) {
    const mid       = Math.ceil(scoreNums.length / 2);
    const recentAvg = averageOf(scoreNums.slice(mid)) ?? 50;
    const olderAvg  = averageOf(scoreNums.slice(0, mid)) ?? 50;
    if (recentAvg > olderAvg + 5)      peak_score_trend = 'rising';
    else if (recentAvg < olderAvg - 5) peak_score_trend = 'declining';
    else                               peak_score_trend = 'stable';
  }

  // ── Per-session-type signal ───────────────────────────────────────────────────
  const categoryMap: Record<Category, SessionSignal[]> = {
    threshold_run: [],
    tempo_run:     [],
    z2:            [],
    strength:      [],
    station_work:  [],
  };

  for (const o of outcomes) {
    const cat = sessionCategory(o.confirmed_as ?? '');
    if (cat) categoryMap[cat].push(o.outcome_signal as SessionSignal);
  }

  // Use the most recent signal for each type as the adaptation direction
  function aggregate(signals: SessionSignal[]): AdaptationSignal | null {
    if (!signals.length) return null;
    return signalToAdaptation(signals[signals.length - 1]);
  }

  // ── Notes ─────────────────────────────────────────────────────────────────────
  const notes: string[] = [];
  if (overall_fatigue === 'critical')    notes.push('Critical fatigue — drop one hard session, replace with easy recovery.');
  if (overall_fatigue === 'accumulated') notes.push('Accumulated fatigue — hold intensity, prioritize sleep and nutrition.');
  if (pullbackCount >= 3)                notes.push('Multiple pullback signals — athlete is overreaching.');
  if (peak_score_trend === 'declining')  notes.push('Peak score trending down — review sleep quality and recovery habits.');
  if (peak_score_trend === 'rising')     notes.push('Athlete is adapting well — progressive overload is appropriate.');

  return {
    threshold_run:    aggregate(categoryMap.threshold_run),
    tempo_run:        aggregate(categoryMap.tempo_run),
    z2:               aggregate(categoryMap.z2),
    strength:         aggregate(categoryMap.strength),
    station_work:     aggregate(categoryMap.station_work),
    overall_fatigue,
    peak_score_trend,
    notes,
  };
}
