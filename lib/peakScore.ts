import { supabase } from './supabase';

export type PeakScoreResult = {
  score: number;
  zone: 'peak' | 'build' | 'rest';
  coachingLine: string;
  baselineDay: number;
  hrvBaseline: number | null;
  rhrBaseline: number | null;
  sleepBaseline: number | null;
};

type ScoreInputs = {
  hrv: number | null;
  rhr: number | null;
  sleepHours: number | null;
  activeCalories: number | null;
};

function avg(nums: (number | null)[]): number | null {
  const valid = nums.filter((n): n is number => n != null && !isNaN(n));
  return valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

// HRV: higher = better. Score 50 at baseline, slides ±100 with deviation.
function scoreHRV(hrv: number, baseline: number): number {
  return clamp(50 + ((hrv - baseline) / baseline) * 100, 0, 100);
}

// RHR: lower = better.
function scoreRHR(rhr: number, baseline: number): number {
  return clamp(50 - ((rhr - baseline) / baseline) * 100, 0, 100);
}

// Sleep: optimal 8h, drops 15pts per hour of deviation.
function scoreSleep(hours: number): number {
  return clamp(100 - Math.abs(hours - 8) * 15, 0, 100);
}

// Training load: active cals vs baseline. 50 at baseline.
function scoreLoad(cals: number, baseline: number): number {
  if (baseline === 0) return 50;
  return clamp(50 + ((cals - baseline) / baseline) * 50, 0, 100);
}

function zoneFromScore(score: number): 'peak' | 'build' | 'rest' {
  if (score >= 80) return 'peak';
  if (score >= 60) return 'build';
  return 'rest';
}

const COACHING: Record<string, string[]> = {
  peak: [
    "You're firing on all cylinders. Push hard today.",
    "Body is primed. Make this session count.",
    "Peak readiness — capitalize on it.",
  ],
  build: [
    "Good readiness. Solid training day ahead.",
    "Your body is responding well. Stay consistent.",
    "Steady state — keep building momentum.",
  ],
  rest: [
    "Your body is asking for recovery. Go easy today.",
    "Prioritize sleep and nutrition — the adaptation happens here.",
    "Active recovery will serve you more than intensity today.",
  ],
};

function pickCoachingLine(zone: string, score: number): string {
  const lines = COACHING[zone] ?? COACHING.build;
  return lines[Math.floor(score) % lines.length];
}

export async function calculatePeakScore(
  userId: string,
  inputs: ScoreInputs,
): Promise<PeakScoreResult | null> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const twoWeeksAgo = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);

    const { data: history } = await supabase
      .from('daily_health_readings')
      .select('hrv, resting_hr, sleep_hours, active_calories')
      .eq('user_id', userId)
      .gte('reading_date', twoWeeksAgo)
      .lt('reading_date', today)
      .order('reading_date', { ascending: false });

    const rows = history ?? [];
    const baselineDay = Math.min(rows.length + 1, 14);

    const hrvBaseline  = avg(rows.map(r => r.hrv));
    const rhrBaseline  = avg(rows.map(r => r.resting_hr));
    const sleepBaseline = avg(rows.map(r => r.sleep_hours));
    const loadBaseline  = avg(rows.map(r => r.active_calories)) ?? 300;

    const hasHRV = inputs.hrv != null && inputs.hrv > 0 && hrvBaseline != null;
    const sHRV   = hasHRV ? scoreHRV(inputs.hrv!, hrvBaseline!) : null;
    const sRHR   = inputs.rhr != null && rhrBaseline != null ? scoreRHR(inputs.rhr, rhrBaseline) : null;
    const sSleep = inputs.sleepHours != null ? scoreSleep(inputs.sleepHours) : null;
    const sLoad  = inputs.activeCalories != null ? scoreLoad(inputs.activeCalories, loadBaseline) : null;

    let score: number;
    if (hasHRV) {
      score = Math.round(
        (sHRV ?? 50) * 0.35 +
        (sRHR ?? 50) * 0.25 +
        (sSleep ?? 50) * 0.30 +
        (sLoad ?? 50) * 0.10,
      );
    } else {
      score = Math.round(
        (sRHR ?? 50) * 0.40 +
        (sSleep ?? 50) * 0.45 +
        (sLoad ?? 50) * 0.15,
      );
    }

    const zone = zoneFromScore(score);
    const coachingLine = pickCoachingLine(zone, score);

    await supabase.from('peak_scores').upsert({
      user_id: userId,
      score_date: today,
      score,
      zone,
      hrv_value: inputs.hrv,
      hrv_baseline: hrvBaseline,
      rhr_value: inputs.rhr,
      rhr_baseline: rhrBaseline,
      sleep_hours: inputs.sleepHours,
      sleep_baseline: sleepBaseline,
      training_load: inputs.activeCalories,
      baseline_day: baselineDay,
      coaching_line: coachingLine,
    }, { onConflict: 'user_id,score_date' });

    console.log('[peakScore] score:', score, 'zone:', zone, 'baselineDay:', baselineDay);
    return { score, zone, coachingLine, baselineDay, hrvBaseline, rhrBaseline, sleepBaseline };
  } catch (e) {
    console.log('[peakScore] error:', e);
    return null;
  }
}
