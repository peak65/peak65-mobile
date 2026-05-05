import { supabase } from './supabase';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TrainingZones = {
  threshold_pace_per_km: number;
  easy_pace_per_km: number;
  tempo_pace_per_km: number;
  threshold_hr: number;
  z1_max_hr: number;
  z2_max_hr: number;
  z3_max_hr: number;
  z4_max_hr: number;
  zone_source: 'estimated' | 'time_trial' | 'training_data' | 'needs_review';
};

export type ZoneDeriveParams = {
  trialType: 'hyrox_8k' | 'gf_20min';
  durationSeconds: number;
  distanceKm: number;
  avgHRLastPortion: number | null;
  userAge: number;
};

export type UserZones = {
  threshold_hr: number | null;
  z1_max_hr: number | null;
  z2_max_hr: number | null;
  z3_max_hr: number | null;
  z4_max_hr: number | null;
};

export type EffortZone = 'z1' | 'z2' | 'z3' | 'z4' | 'z5' | 'unknown';

export const EFFORT_LABELS: Record<EffortZone, string> = {
  z1: 'Recovery',
  z2: 'Easy',
  z3: 'Tempo',
  z4: 'Threshold',
  z5: 'Max',
  unknown: 'Unknown',
};

// ─── deriveZonesFromTimeTrial ─────────────────────────────────────────────────

export function deriveZonesFromTimeTrial(params: ZoneDeriveParams): TrainingZones {
  const { trialType, durationSeconds, distanceKm, avgHRLastPortion, userAge } = params;

  const threshold_pace_per_km = durationSeconds / distanceKm;
  const ageBasedThresholdHR = Math.round((208 - 0.7 * userAge) * 0.90);

  let easy_pace_per_km: number;
  let tempo_pace_per_km: number;
  let threshold_hr: number;
  let zone_source: 'estimated' | 'time_trial';

  if (trialType === 'hyrox_8k') {
    easy_pace_per_km  = threshold_pace_per_km + 60;
    tempo_pace_per_km = threshold_pace_per_km + 20;
    threshold_hr = avgHRLastPortion != null
      ? Math.round(avgHRLastPortion * 0.97)
      : ageBasedThresholdHR;
    zone_source = avgHRLastPortion != null ? 'time_trial' : 'estimated';
  } else {
    // gf_20min
    easy_pace_per_km  = threshold_pace_per_km + 75;
    tempo_pace_per_km = threshold_pace_per_km + 25;
    threshold_hr = avgHRLastPortion != null
      ? Math.round(avgHRLastPortion * 0.95)
      : ageBasedThresholdHR;
    zone_source = avgHRLastPortion != null ? 'time_trial' : 'estimated';
  }

  return {
    threshold_pace_per_km,
    easy_pace_per_km,
    tempo_pace_per_km,
    threshold_hr,
    z1_max_hr: Math.round(threshold_hr * 0.80),
    z2_max_hr: Math.round(threshold_hr * 0.87),
    z3_max_hr: Math.round(threshold_hr * 0.95),
    z4_max_hr: Math.round(threshold_hr * 1.02),
    zone_source,
  };
}

// ─── classifyEffort ───────────────────────────────────────────────────────────

export function classifyEffort(avgHR: number, zones: UserZones): EffortZone {
  if (
    zones.threshold_hr == null ||
    zones.z1_max_hr == null ||
    zones.z2_max_hr == null ||
    zones.z3_max_hr == null ||
    zones.z4_max_hr == null
  ) return 'unknown';

  if (avgHR <= zones.z1_max_hr) return 'z1';
  if (avgHR <= zones.z2_max_hr) return 'z2';
  if (avgHR <= zones.z3_max_hr) return 'z3';
  if (avgHR <= zones.z4_max_hr) return 'z4';
  return 'z5';
}

// ─── refinePaceZones — called periodically after programmed run sessions ──────

type RecentRun = {
  prescribedZone: string;
  avgHR: number;
};

type RefinableZones = UserZones & {
  z2_max_hr: number;
  z3_max_hr: number | null;
  zone_calibration_runs?: number;
};

export async function refinePaceZones(
  userId: string,
  existingZones: RefinableZones,
  recentRuns: RecentRun[],
): Promise<void> {
  if (existingZones.threshold_hr == null) return;

  const z2Runs = recentRuns.filter(r => r.prescribedZone === 'z2');
  if (z2Runs.length < 3) return;

  const avgZ2HR = z2Runs.reduce((sum, r) => sum + r.avgHR, 0) / z2Runs.length;
  const calRuns = (existingZones.zone_calibration_runs ?? 0) + 1;
  let newZ2Max = existingZones.z2_max_hr;
  let zoneSource: string = calRuns >= 10 ? 'training_data' : 'time_trial';

  if (avgZ2HR < existingZones.z2_max_hr - 5) {
    newZ2Max = existingZones.z2_max_hr + 3;
  } else if (existingZones.z3_max_hr != null && avgZ2HR > existingZones.z3_max_hr) {
    zoneSource = 'needs_review';
  }

  await supabase.from('profiles').update({
    z2_max_hr: newZ2Max,
    zone_source: zoneSource,
    zone_calibration_runs: calRuns,
    last_zone_update: new Date().toISOString(),
  }).eq('id', userId);

  console.log('[zones] refined: new z2_max_hr=', newZ2Max, 'source=', zoneSource, 'calibration runs=', calRuns);
}
