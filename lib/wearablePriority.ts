import type { WearableHealthData, HealthReading } from './healthKit';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface ConnectedWearables {
  whoop: boolean;        // Whoop direct API
  garmin: boolean;       // Garmin direct API
  coros: boolean;        // Coros direct API
  appleHealth: boolean;  // Apple Health bridge (covers Zepp, Polar, Apple Watch, Whoop via bridge)
}

export interface WearableReading {
  value: number | null;
  source: string | null;
  confidence: 'high' | 'medium' | null;
  noWearable: boolean;
}

type ProfileForPriority = {
  whoop_connected?: boolean | null;
  garmin_connected?: boolean | null;
  coros_connected?: boolean | null;
  wearable_connected?: boolean | null;
  manual_hrv?: number | null;
  manual_hrv_date?: string | null;
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

function matchSrc(source: string | null | undefined, ...keys: string[]): boolean {
  if (!source) return false;
  const l = source.toLowerCase();
  return keys.some(k => l.includes(k));
}

function isAppleWatch(source: string | null | undefined): boolean {
  if (!source) return false;
  const l = source.toLowerCase();
  return l.includes('apple watch') || l.endsWith(' watch');
}

function noData(): WearableReading {
  return { value: null, source: null, confidence: null, noWearable: true };
}

function fromReading(
  reading: HealthReading,
  confidence: 'high' | 'medium',
  sourceLabel: string,
): WearableReading {
  return { value: reading.value, source: sourceLabel, confidence, noWearable: false };
}

// ─── getConnectedWearables ────────────────────────────────────────────────────

export function getConnectedWearables(profile: ProfileForPriority): ConnectedWearables {
  return {
    whoop:       profile.whoop_connected === true,
    garmin:      profile.garmin_connected === true,
    coros:       profile.coros_connected === true,
    appleHealth: profile.wearable_connected === true,
  };
}

// ─── selectActiveCalorieSource ────────────────────────────────────────────────
// NEVER returns iPhone — wearable required for calorie tracking

export function selectActiveCalorieSource(healthData: WearableHealthData): WearableReading {
  const r = healthData.activeCalories;
  if (!r) return noData();
  const s = r.source;
  if (matchSrc(s, 'garmin'))           return fromReading(r, 'high', 'Garmin');
  if (matchSrc(s, 'coros'))            return fromReading(r, 'high', 'Coros');
  if (matchSrc(s, 'zepp', 'amazfit')) return fromReading(r, 'high', 'Zepp');
  if (matchSrc(s, 'polar'))            return fromReading(r, 'high', 'Polar');
  if (matchSrc(s, 'whoop'))            return fromReading(r, 'high', 'Whoop');
  if (isAppleWatch(s))                 return fromReading(r, 'medium', 'Apple Watch');
  // iPhone or unknown — not a valid active calorie source
  return noData();
}

// ─── selectHRVSource ──────────────────────────────────────────────────────────
// Falls through to manual HRV if no HK HRV found

export function selectHRVSource(
  healthData: WearableHealthData,
  profile: ProfileForPriority,
): WearableReading {
  const r = healthData.hrv;
  if (r) {
    const s = r.source;
    if (matchSrc(s, 'garmin'))           return fromReading(r, 'high', 'Garmin');
    if (matchSrc(s, 'whoop'))            return fromReading(r, 'high', 'Whoop');
    if (matchSrc(s, 'oura'))             return fromReading(r, 'high', 'Oura');
    if (matchSrc(s, 'polar'))            return fromReading(r, 'high', 'Polar');
    if (matchSrc(s, 'coros'))            return fromReading(r, 'high', 'Coros');
    if (isAppleWatch(s))                 return fromReading(r, 'medium', 'Apple Watch');
    if (matchSrc(s, 'zepp', 'amazfit')) return fromReading(r, 'medium', 'Zepp');
  }
  // Manual HRV fallback (Zepp users logging manually)
  const today = new Date().toISOString().slice(0, 10);
  if (profile.manual_hrv != null && profile.manual_hrv_date === today) {
    return { value: profile.manual_hrv, source: 'Manual (Zepp)', confidence: 'medium', noWearable: false };
  }
  return noData();
}

// ─── selectRHRSource ──────────────────────────────────────────────────────────

export function selectRHRSource(healthData: WearableHealthData): WearableReading {
  const r = healthData.restingHR;
  if (!r) return noData();
  const s = r.source;
  if (matchSrc(s, 'whoop'))            return fromReading(r, 'high', 'Whoop');
  if (matchSrc(s, 'garmin'))           return fromReading(r, 'high', 'Garmin');
  if (matchSrc(s, 'oura'))             return fromReading(r, 'high', 'Oura');
  if (matchSrc(s, 'polar'))            return fromReading(r, 'high', 'Polar');
  if (matchSrc(s, 'coros'))            return fromReading(r, 'high', 'Coros');
  if (matchSrc(s, 'zepp', 'amazfit')) return fromReading(r, 'high', 'Zepp');
  if (isAppleWatch(s))                 return fromReading(r, 'medium', 'Apple Watch');
  return noData();
}

// ─── selectSleepSource ────────────────────────────────────────────────────────

export function selectSleepSource(healthData: WearableHealthData): WearableReading {
  const r = healthData.sleepHours;
  if (!r) return noData();
  const s = r.source;
  if (matchSrc(s, 'whoop'))            return fromReading(r, 'high', 'Whoop');
  if (matchSrc(s, 'oura'))             return fromReading(r, 'high', 'Oura');
  if (matchSrc(s, 'garmin'))           return fromReading(r, 'high', 'Garmin');
  if (matchSrc(s, 'polar'))            return fromReading(r, 'medium', 'Polar');
  if (matchSrc(s, 'zepp', 'amazfit')) return fromReading(r, 'medium', 'Zepp');
  if (isAppleWatch(s))                 return fromReading(r, 'medium', 'Apple Watch');
  return noData();
}

// ─── selectStepsSource ────────────────────────────────────────────────────────
// Steps is the ONLY metric where iPhone is an acceptable fallback

export function selectStepsSource(healthData: WearableHealthData): WearableReading {
  const r = healthData.steps;
  if (!r) return noData();
  const s = r.source;
  if (matchSrc(s, 'garmin'))           return fromReading(r, 'high', 'Garmin');
  if (matchSrc(s, 'coros'))            return fromReading(r, 'high', 'Coros');
  if (matchSrc(s, 'whoop'))            return fromReading(r, 'high', 'Whoop');
  if (matchSrc(s, 'zepp', 'amazfit')) return fromReading(r, 'high', 'Zepp');
  if (matchSrc(s, 'polar'))            return fromReading(r, 'medium', 'Polar');
  if (isAppleWatch(s))                 return fromReading(r, 'medium', 'Apple Watch');
  if (matchSrc(s, 'iphone'))          return fromReading(r, 'medium', 'iPhone'); // steps only
  return noData();
}

// ─── selectTotalCalorieSource ─────────────────────────────────────────────────
// Total is the ONE exception to no-fallback: TDEE base alone is valid for nutrition

export function selectTotalCalorieSource(
  wearables: ConnectedWearables,
  healthData: WearableHealthData,
  tdeeBase: number | null,
  activeCalories: WearableReading,
): WearableReading {
  // Direct API integrations (not yet built — placeholder for Whoop/Garmin/Coros)
  // if (wearables.whoop) { ... }
  // if (wearables.garmin) { ... }
  // if (wearables.coros) { ... }

  if (!activeCalories.noWearable && activeCalories.value != null && tdeeBase != null) {
    return {
      value: tdeeBase + activeCalories.value,
      source: `${activeCalories.source} + Calculated`,
      confidence: activeCalories.confidence,
      noWearable: false,
    };
  }

  // No wearable active calories — TDEE base only (valid for nutrition coaching)
  if (tdeeBase != null) {
    return { value: tdeeBase, source: 'Calculated', confidence: 'medium', noWearable: false };
  }

  return noData();
}

// ─── selectWorkoutHRSource ────────────────────────────────────────────────────

export function selectWorkoutHRSource(workoutSourceName: string | null): {
  confidence: 'high' | 'medium' | null;
} {
  if (matchSrc(workoutSourceName, 'garmin'))           return { confidence: 'high' };
  if (matchSrc(workoutSourceName, 'coros'))            return { confidence: 'high' };
  if (matchSrc(workoutSourceName, 'polar'))            return { confidence: 'high' };
  if (matchSrc(workoutSourceName, 'zepp', 'amazfit')) return { confidence: 'high' };
  if (matchSrc(workoutSourceName, 'whoop'))            return { confidence: 'medium' };
  if (isAppleWatch(workoutSourceName))                 return { confidence: 'medium' };
  return { confidence: null };
}

// ─── resolveAllSources — log all selections in one place ──────────────────────

export function resolveAllSources(
  wearables: ConnectedWearables,
  healthData: WearableHealthData,
  profile: ProfileForPriority,
  tdeeBase: number | null,
): {
  activeCal: WearableReading;
  hrv: WearableReading;
  rhr: WearableReading;
  sleep: WearableReading;
  steps: WearableReading;
  totalCal: WearableReading;
} {
  const activeCal = selectActiveCalorieSource(healthData);
  const hrv       = selectHRVSource(healthData, profile);
  const rhr       = selectRHRSource(healthData);
  const sleep     = selectSleepSource(healthData);
  const steps     = selectStepsSource(healthData);
  const totalCal  = selectTotalCalorieSource(wearables, healthData, tdeeBase, activeCal);

  console.log('[wearable] connected:', wearables);
  console.log('[wearable] sources selected:', { activeCal, hrv, rhr, sleep, steps, totalCal });

  return { activeCal, hrv, rhr, sleep, steps, totalCal };
}
