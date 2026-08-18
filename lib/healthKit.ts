import { Platform } from 'react-native';
import AppleHealthKit, {
  HealthInputOptions,
  HealthKitPermissions,
  HealthValue,
} from 'react-native-health';
import { supabase } from './supabase';
import { classifyEffort, type UserZones } from './zoneDerivation';

// ─── Public types ─────────────────────────────────────────────────────────────

export type HealthData = {
  steps: number | null;
  activeCalories: number | null;
  totalCalories: number | null;
  restingHR: number | null;
  hrv: number | null;
  sleepHours: number | null;
  exerciseMinutes: number | null;
  lastActiveCalSync: string | null;
};

export type DailyPoint = { date: string; value: number };

export type HealthReading = { value: number; source: string };

export type WearableHealthData = {
  hrv: HealthReading | null;
  restingHR: HealthReading | null;
  sleepHours: HealthReading | null;
  steps: HealthReading | null;
  activeCalories: HealthReading | null;
  basalCalories: HealthReading | null;
  totalCalories: HealthReading | null;
};

// ─── Internal sample type (sourceName present at runtime, not in TS types) ───

type HKSampleMetadata = { sourceName?: string; sourceId?: string; quantity?: number };

type HKSample = HealthValue & {
  sourceName?: string;
  sourceId?: string;
  // sourceRevision.productType, e.g. "Watch6,1" / "iPhone14,2". Emitted only by
  // getSamples-backed reads (steps, active/basal calories) — absent on HRV,
  // resting HR and sleep. See RCTAppleHealthKit+Queries.m fetchSamplesOfType.
  device?: string;
  metadata?: HKSampleMetadata[];
};

// Extracts the numeric value from a sample regardless of which field the HealthKit
// bridge populates (getSamples uses 'quantity', point-in-time methods use 'value').
function sampleNumericValue(s: HKSample): number {
  const v = (s as any).quantity ?? s.value ?? (s as any).quantitySamples?.[0]?.value;
  return typeof v === 'number' ? v : 0;
}

// Apple Health sometimes wraps third-party samples under sourceName="Apple Health"
// while preserving the real wearable source in metadata[0].sourceName or sourceId.
// Check metadata first, then fall back to top-level sourceId (bundle ID) so Zepp
// (com.huami.xxx) and other wearables are matched even when sourceName is absent.
function getSampleSource(s: HKSample): string {
  return s.metadata?.[0]?.sourceName
    ?? s.metadata?.[0]?.sourceId
    ?? s.sourceName
    ?? (s as any).sourceId
    ?? '';
}

// ─── Source priority ──────────────────────────────────────────────────────────

type PriorityLevel = { name: string; keys: string[] };

// Per-metric priority arrays — Whoop leads for all recovery/sleep metrics;
// GPS devices (Garmin/Coros) lead for activity metrics.
const PRIORITY_HRV: PriorityLevel[] = [
  { name: 'Whoop',       keys: ['whoop'] },
  { name: 'Garmin',      keys: ['garmin'] },
  { name: 'Zepp',        keys: ['zepp', 'amazfit', 'huami'] },
  { name: 'Polar',       keys: ['polar'] },
  { name: 'Apple Watch', keys: ['apple watch', ' watch'] },
];

const PRIORITY_RHR: PriorityLevel[] = [
  { name: 'Whoop',       keys: ['whoop'] },
  { name: 'Garmin',      keys: ['garmin'] },
  { name: 'Zepp',        keys: ['zepp', 'amazfit', 'huami'] },
  { name: 'Polar',       keys: ['polar'] },
  { name: 'Apple Watch', keys: ['apple watch', ' watch'] },
];

const PRIORITY_SLEEP: PriorityLevel[] = [
  { name: 'Whoop',       keys: ['whoop'] },
  { name: 'Garmin',      keys: ['garmin'] },
  { name: 'Zepp',        keys: ['zepp', 'amazfit', 'huami'] },
  { name: 'Apple Watch', keys: ['apple watch', ' watch'] },
];

const PRIORITY_STEPS: PriorityLevel[] = [
  { name: 'Whoop',       keys: ['whoop'] },
  { name: 'Garmin',      keys: ['garmin'] },
  { name: 'Coros',       keys: ['coros'] },
  { name: 'Zepp',        keys: ['zepp', 'amazfit', 'huami'] },
  { name: 'Apple Watch', keys: ['apple watch', ' watch'] },
];

const PRIORITY_CALORIES: PriorityLevel[] = [
  { name: 'Whoop',       keys: ['whoop'] },
  { name: 'Garmin',      keys: ['garmin'] },
  { name: 'Coros',       keys: ['coros'] },
  { name: 'Zepp',        keys: ['zepp', 'amazfit', 'huami'] },
  { name: 'Polar',       keys: ['polar'] },
  { name: 'Apple Watch', keys: ['apple watch', ' watch'] },
];

const IPHONE_PRIORITY: PriorityLevel = { name: 'iPhone', keys: ['iphone', 'apple health'] };

function sourceMatches(sourceName: string | undefined, keys: string[]): boolean {
  if (!sourceName) return false;
  const l = sourceName.toLowerCase();
  return keys.some(k => l.includes(k));
}

// ─── Apple-device origin gate ─────────────────────────────────────────────────
//
// Apple Health is an Apple-DEVICES-ONLY source here, never a bridge. A sample
// that Whoop / Oura / Zepp / Garmin wrote into HealthKit is DROPPED, not
// relabelled — third-party data may only reach us through its own direct
// integration, where it carries its true source and its real priority.
//
// react-native-health@1.19.0 bridges origin as a FLAT shape (NOT the nested
// sample.device.model / sample.sourceRevision.source.bundleIdentifier of other
// HealthKit wrappers):
//   sourceId — source.bundleIdentifier; present on every read we perform
//   device   — sourceRevision.productType ("Watch6,1"); getSamples reads only
// Bundle id is therefore the only gate available on all metrics; `device`
// refines Watch-vs-iPhone where it exists.
const APPLE_BUNDLE_PREFIX = 'com.apple.';

function isAppleBundle(s: HKSample): boolean {
  return (s.sourceId ?? '').toLowerCase().trim().startsWith(APPLE_BUNDLE_PREFIX);
}

// Device from productType. null means the read carried NO device field at all
// (HRV / resting HR / sleep); 'Other' means one was present but is neither Watch
// nor iPhone (iPad, Mac...) — which must reject, not fall through to the bundle.
function deviceKind(s: HKSample): 'Watch' | 'iPhone' | 'Other' | null {
  const d = (s.device ?? '').trim();
  if (d === '') return null;
  if (/^watch/i.test(d)) return 'Watch';
  if (/^iphone/i.test(d)) return 'iPhone';
  return 'Other';
}

// A genuine Apple Watch sample. A third-party bundle is rejected outright,
// whatever `device` claims. Where `device` is present it is authoritative, so a
// non-Watch Apple device is rejected. Where it is absent the Apple bundle is the
// signal — an iPhone has no sensor for HRV, resting HR or sleep, so an Apple
// bundle on those reads can only be the Watch.
function isAppleWatchSample(s: HKSample): boolean {
  if (!isAppleBundle(s)) return false;
  const kind = deviceKind(s);
  return kind === null ? true : kind === 'Watch';
}

// Any Apple-owned device. Used for steps, where the iPhone is a legitimate
// lower-priority counter.
function isAppleOwnSample(s: HKSample): boolean {
  if (!isAppleBundle(s)) return false;
  const kind = deviceKind(s);
  return kind === null ? true : kind === 'Watch' || kind === 'iPhone';
}

// The sample sets are pre-filtered by the gate above, so no cross-source ladder
// is left to walk — this single permissive level preserves each picker's
// aggregation (most-recent for pickBest, sum for pickBestSum) unchanged.
const ACCEPT_ALL: PriorityLevel[] = [{ name: 'Accepted', keys: [''] }];

// Stamp the canonical device tag. The gate has already established the origin,
// so the raw HealthKit sourceName (user-renameable, e.g. "Kayla's Apple Watch")
// is discarded in favour of a token the priority arrays match exactly.
function tagged(r: HealthReading | null, source: string): HealthReading | null {
  return r ? { value: r.value, source } : null;
}

// ─── Pickers ──────────────────────────────────────────────────────────────────

// Walk priority levels in order; return the most recent sample from the first
// level that has any matching samples.
function pickBest(samples: HKSample[], priorities: PriorityLevel[], includeIphone: boolean, metric: string): HealthReading | null {
  console.log(`[healthkit] ${metric} unique sources:`, [...new Set(samples.map(s => getSampleSource(s)))]);
  const allPriorities = includeIphone ? [...priorities, IPHONE_PRIORITY] : priorities;

  for (const { name, keys } of allPriorities) {
    const matched = samples.filter(s => sourceMatches(getSampleSource(s), keys));
    if (matched.length > 0) {
      console.log(`[healthkit] ${metric} matched priority:`, name, 'count:', matched.length);
      console.log(`[healthkit] ${metric} first sample keys:`, Object.keys(matched[0] ?? {}));
      console.log(`[healthkit] ${metric} first sample:`, JSON.stringify(matched[0]));
      matched.sort((a, b) =>
        new Date(b.endDate ?? b.startDate).getTime() - new Date(a.endDate ?? a.startDate).getTime()
      );
      const best = matched[0];
      return { value: Math.round(sampleNumericValue(best)), source: getSampleSource(best) || 'Unknown' };
    }
  }
  return null;
}

// Sum all samples from the first priority level that has matches.
function pickBestSum(samples: HKSample[], priorities: PriorityLevel[], includeIphone: boolean, metric: string): HealthReading | null {
  console.log(`[healthkit] ${metric} unique sources:`, [...new Set(samples.map(s => getSampleSource(s)))]);
  const allPriorities = includeIphone ? [...priorities, IPHONE_PRIORITY] : priorities;

  for (const { name, keys } of allPriorities) {
    const matched = samples.filter(s => sourceMatches(getSampleSource(s), keys));
    if (matched.length > 0) {
      console.log(`[healthkit] ${metric} matched priority:`, name, 'count:', matched.length);
      console.log(`[healthkit] ${metric} first sample keys:`, Object.keys(matched[0] ?? {}));
      console.log(`[healthkit] ${metric} first sample:`, JSON.stringify(matched[0]));
      const sum = Math.round(matched.reduce((acc, s) => acc + sampleNumericValue(s), 0));
      return { value: sum, source: getSampleSource(matched[0]) || 'Unknown' };
    }
  }
  return null;
}

// Walk wearable priorities; for the first source that has actual sleep-stage
// samples (value ≠ InBed/Awake), sum durations and return total hours.
// If the winning source only recorded InBed/Awake, continue to the next level.
// HK sleep values: 0=InBed, 1=Asleep, 2=Awake, 3=Core, 4=Deep, 5=REM
function pickBestSleep(samples: HKSample[], priorities: PriorityLevel[], metric: string): HealthReading | null {
  console.log(`[healthkit] ${metric} unique sources:`, [...new Set(samples.map(s => getSampleSource(s)))]);

  for (const { name, keys } of priorities) {
    const matched = samples.filter(s => sourceMatches(getSampleSource(s), keys));
    if (matched.length > 0) {
      console.log(`[healthkit] ${metric} matched priority:`, name, 'count:', matched.length);

      // Filter to asleep stages only (exclude InBed=0, Awake=2)
      // HK values: 0=InBed, 1=Asleep, 2=Awake, 3=Core, 4=Deep, 5=REM
      const asleepSamples = matched.filter(s => s.value !== 0 && s.value !== 2);
      if (asleepSamples.length === 0) continue; // only InBed/Awake — try next priority

      // Merge overlapping intervals before summing.
      // Zepp (and some other apps) logs both a whole-night Asleep span AND individual
      // stage sub-intervals within it, which causes naive summation to double-count.
      type Interval = { from: number; to: number };
      const intervals: Interval[] = asleepSamples
        .map(s => ({ from: new Date(s.startDate).getTime(), to: new Date(s.endDate).getTime() }))
        .filter(i => i.to > i.from)
        .sort((a, b) => a.from - b.from);

      const merged: Interval[] = [];
      for (const iv of intervals) {
        const last = merged[merged.length - 1];
        if (!last || iv.from > last.to) {
          merged.push({ ...iv });
        } else {
          last.to = Math.max(last.to, iv.to);
        }
      }

      console.log(`[healthkit] ${metric} merged intervals before pick:`, JSON.stringify(merged));

      // If more than one merged block (e.g. two separate nights snuck into the window),
      // take only the latest block — that's last night's sleep session.
      const block = merged.length > 1 ? merged[merged.length - 1] : merged[0];
      if (!block) continue;

      const ms = block.to - block.from;
      if (ms > 0) {
        const rawHours = ms / (1000 * 60 * 60);
        const hours = Math.min(Math.round(rawHours * 10) / 10, 16); // sanity cap
        console.log(`[healthkit] ${metric} asleep samples:`, asleepSamples.length, 'merged intervals:', merged.length, 'hours:', hours);
        return hours > 0.25 ? { value: hours, source: getSampleSource(matched[0]) || 'Unknown' } : null;
      }
    }
  }
  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Wraps a callback-based HealthKit array query into a Promise that always
// resolves (returns [] on error so Promise.allSettled always fulfils).
function hkArray<T>(
  query: (cb: (err: string, results: T[]) => void) => void,
): Promise<T[]> {
  return new Promise(resolve =>
    query((err, results) => {
      if (err || !results) console.log('[healthkit] hkArray error:', err);
      resolve(err || !results ? [] : results);
    })
  );
}

function settled<T>(r: PromiseSettledResult<T[]>): T[] {
  return r.status === 'fulfilled' ? r.value : [];
}

function todayStart(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

function sumValues(values: HealthValue[]): number {
  return Math.round(values.reduce((acc, v) => acc + v.value, 0));
}

// ─── Permissions ──────────────────────────────────────────────────────────────

const PERMISSIONS: HealthKitPermissions = {
  permissions: {
    read: [
      AppleHealthKit.Constants.Permissions.HeartRateVariability,
      AppleHealthKit.Constants.Permissions.RestingHeartRate,
      AppleHealthKit.Constants.Permissions.SleepAnalysis,
      AppleHealthKit.Constants.Permissions.Steps,
      AppleHealthKit.Constants.Permissions.ActiveEnergyBurned,
      AppleHealthKit.Constants.Permissions.BasalEnergyBurned,
      AppleHealthKit.Constants.Permissions.HeartRate,
      AppleHealthKit.Constants.Permissions.Workout,
    ],
    write: [],
  },
};

// ─── Permission request ───────────────────────────────────────────────────────

export function requestHealthPermissions(): Promise<boolean> {
  console.log('[HealthKit] requestHealthPermissions called');
  console.log('[HealthKit] Platform.OS:', Platform.OS);

  if (Platform.OS !== 'ios') {
    console.log('[HealthKit] Not iOS — returning false immediately');
    return Promise.resolve(false);
  }

  console.log('[HealthKit] Passing permissions to initHealthKit:', JSON.stringify(PERMISSIONS, null, 2));

  return new Promise(resolve => {
    AppleHealthKit.initHealthKit(PERMISSIONS, err => {
      if (err) {
        console.log('[HealthKit] initHealthKit error:', JSON.stringify(err));
        resolve(false);
      } else {
        console.log('[HealthKit] initHealthKit succeeded — permissions granted');
        resolve(true);
      }
    });
  });
}

// ─── Energy samples helper — tries multiple type strings then aggregated fallback ─

// Tries primaryType then fallbackType via getSamples(). If both return empty,
// falls back to the named aggregated method and synthesizes sourceName = 'Apple Health'
// so the priority picker can still match it (mapped to iPhone priority).
async function fetchEnergySamples(
  label: string,
  primaryType: string,
  fallbackType: string,
  aggregatedMethod: string,
  startDate: string,
  endDate: string,
): Promise<HKSample[]> {
  console.log(`[healthkit] fetchEnergySamples called: label=${label}, startDate=${startDate}, endDate=${endDate}`);
  for (const typeStr of [primaryType, fallbackType]) {
    const samples = await hkArray<HKSample>(cb => {
      console.log(`[healthkit] ${label}: trying getSamples type="${typeStr}"`);
      (AppleHealthKit as any).getSamples({ type: typeStr, startDate, endDate }, cb);
    });
    if (samples.length > 0) {
      const first = samples[0];
      console.log(`[healthkit] ${label}: returning ${samples.length} samples from type="${typeStr}"`);
      console.log(`[healthkit] ${label} sample resolved source:`, getSampleSource(first), 'top:', first?.sourceName, 'meta:', first?.metadata?.[0]?.sourceName);
      return samples;
    }
    console.log(`[healthkit] ${label}: empty result for type="${typeStr}"`);
  }

  // Both getSamples attempts returned empty — try aggregated function
  console.log(`[healthkit] ${label}: falling back to ${aggregatedMethod}()`);
  const aggregated = await hkArray<HKSample>(cb =>
    (AppleHealthKit as any)[aggregatedMethod]({ startDate, endDate }, cb)
  );
  if (aggregated.length > 0) {
    console.log(`[healthkit] ${label}: ${aggregatedMethod}() returned`, aggregated.length, 'samples');
    return aggregated.map(s => ({ ...s, sourceName: s.sourceName ?? 'Apple Health' }));
  }

  console.log(`[healthkit] ${label}: no data found from any source`);
  return [];
}

// ─── fetchTodayHealthData — wearable-priority ─────────────────────────────────

export async function fetchTodayHealthData(): Promise<WearableHealthData> {
  console.log('[healthkit] fetchTodayHealthData called');

  const empty: WearableHealthData = {
    hrv: null, restingHR: null, sleepHours: null,
    steps: null, activeCalories: null, basalCalories: null, totalCalories: null,
  };
  if (Platform.OS !== 'ios') return empty;

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const startDate48h = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  // Noon yesterday: captures last night's sleep session without reaching back two nights
  const noonYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0, 0);

  console.log('[healthkit] date range today:', startOfToday.toISOString(), 'to', now.toISOString());
  console.log('[healthkit] date range 48h:', startDate48h.toISOString(), 'to', now.toISOString());
  console.log('[healthkit] date range sleep:', noonYesterday.toISOString(), 'to', now.toISOString());

  const [hrvR, rhrR, sleepR, stepsR, activeR, basalR] = await Promise.allSettled([
    new Promise<HKSample[]>(resolve => {
      const opts = { startDate: startDate48h.toISOString(), endDate: now.toISOString() };
      console.log('[healthkit] hrv options:', JSON.stringify(opts));
      AppleHealthKit.getHeartRateVariabilitySamples(opts, (err, results) => {
        console.log('[healthkit] hrv callback err:', err, 'count:', (results as unknown as HKSample[])?.length ?? 0);
        resolve(err || !results ? [] : results as unknown as HKSample[]);
      });
    }),
    new Promise<HKSample[]>(resolve => {
      const opts = { startDate: startDate48h.toISOString(), endDate: now.toISOString() };
      console.log('[healthkit] rhr options:', JSON.stringify(opts));
      AppleHealthKit.getRestingHeartRateSamples(opts, (err, results) => {
        console.log('[healthkit] rhr callback err:', err, 'count:', (results as unknown as HKSample[])?.length ?? 0);
        resolve(err || !results ? [] : results as unknown as HKSample[]);
      });
    }),
    new Promise<HKSample[]>(resolve => {
      const opts = { startDate: noonYesterday.toISOString(), endDate: now.toISOString() };
      console.log('[healthkit] sleep options:', JSON.stringify(opts));
      AppleHealthKit.getSleepSamples(opts, (err, results) => {
        console.log('[healthkit] sleep callback err:', err, 'count:', (results as unknown as HKSample[])?.length ?? 0);
        resolve(err || !results ? [] : results as unknown as HKSample[]);
      });
    }),
    new Promise<HKSample[]>(resolve => {
      const opts = { type: 'StepCount', startDate: startOfToday.toISOString(), endDate: now.toISOString() };
      console.log('[healthkit] steps options:', JSON.stringify(opts));
      (AppleHealthKit as any).getSamples(opts, (err: string, results: HKSample[]) => {
        console.log('[healthkit] steps callback err:', err, 'count:', results?.length ?? 0);
        resolve(err || !results ? [] : results);
      });
    }),
    fetchEnergySamples(
      'active calories',
      'ActiveEnergyBurned',
      'HKQuantityTypeIdentifierActiveEnergyBurned',
      'getActiveEnergyBurned',
      startOfToday.toISOString(),
      now.toISOString(),
    ),
    fetchEnergySamples(
      'basal calories',
      'BasalEnergyBurned',
      'HKQuantityTypeIdentifierBasalEnergyBurned',
      'getBasalEnergyBurned',
      startOfToday.toISOString(),
      now.toISOString(),
    ),
  ]);

  const hrvSamples   = settled(hrvR);   console.log('[healthkit] hrv raw samples:', JSON.stringify(hrvSamples));
  const rhrSamples   = settled(rhrR);   console.log('[healthkit] rhr raw samples:', JSON.stringify(rhrSamples));
  const sleepSamples = settled(sleepR); console.log('[healthkit] sleep raw samples:', JSON.stringify(sleepSamples));
  const stepsSamples = settled(stepsR); console.log('[healthkit] steps raw samples:', JSON.stringify(stepsSamples));
  const activeSamples = settled(activeR); console.log('[healthkit] active calories raw samples:', JSON.stringify(activeSamples));
  const basalSamples  = settled(basalR);  console.log('[healthkit] basal calories raw samples:', JSON.stringify(basalSamples));

  // Apple-devices-only gate. Anything a third-party app wrote into HealthKit is
  // dropped here, before aggregation — so a Whoop or Zepp reading yields no
  // sample, the metric resolves to null, and nothing is written for it.
  const hrvApple    = hrvSamples.filter(isAppleWatchSample);
  const rhrApple    = rhrSamples.filter(isAppleWatchSample);
  const sleepApple  = sleepSamples.filter(isAppleWatchSample);
  const activeApple = activeSamples.filter(isAppleWatchSample);
  const basalApple  = basalSamples.filter(isAppleOwnSample);
  // Steps split by device: Watch preferred, iPhone as the lower-priority counter.
  const stepsWatch  = stepsSamples.filter(isAppleWatchSample);
  const stepsPhone  = stepsSamples.filter(s => isAppleOwnSample(s) && !isAppleWatchSample(s));

  console.log('[healthkit] apple-only gate — hrv:', `${hrvApple.length}/${hrvSamples.length}`,
    '| rhr:', `${rhrApple.length}/${rhrSamples.length}`,
    '| sleep:', `${sleepApple.length}/${sleepSamples.length}`,
    '| steps watch/iphone:', `${stepsWatch.length}/${stepsPhone.length} of ${stepsSamples.length}`,
    '| active:', `${activeApple.length}/${activeSamples.length}`);

  const hrv    = tagged(pickBest(hrvApple, ACCEPT_ALL, false, 'hrv'), 'Apple Watch');
  const restHR = tagged(pickBest(rhrApple, ACCEPT_ALL, false, 'rhr'), 'Apple Watch');
  const sleep  = tagged(pickBestSleep(sleepApple, ACCEPT_ALL, 'sleep'), 'Apple Watch');
  const steps  =
    tagged(pickBestSum(stepsWatch, ACCEPT_ALL, false, 'steps-watch'), 'Apple Watch') ??
    tagged(pickBestSum(stepsPhone, ACCEPT_ALL, false, 'steps-iphone'), 'iPhone');
  const active = tagged(pickBestSum(activeApple, ACCEPT_ALL, false, 'active'), 'Apple Watch');
  const basal  = tagged(pickBestSum(basalApple,  ACCEPT_ALL, false, 'basal'),  'Apple Watch');

  console.log('[hrv] source selected:', hrv?.source ?? 'none', 'value:', hrv?.value ?? null);
  console.log('[rhr] source selected:', restHR?.source ?? 'none', 'value:', restHR?.value ?? null);
  console.log('[sleep] source selected:', sleep?.source ?? 'none', 'value:', sleep?.value ?? null);
  console.log('[steps] source selected:', steps?.source ?? 'none', 'value:', steps?.value ?? null);
  console.log('[active] source selected:', active?.source ?? 'none', 'value:', active?.value ?? null);
  console.log('[basal] source selected:', basal?.source ?? 'none', 'value:', basal?.value ?? null);

  const total: HealthReading | null =
    active !== null || basal !== null
      ? {
          value: (active?.value ?? 0) + (basal?.value ?? 0),
          source: active?.source ?? basal?.source ?? 'Unknown',
        }
      : null;

  const result: WearableHealthData = {
    hrv, restingHR: restHR, sleepHours: sleep,
    steps, activeCalories: active, basalCalories: basal, totalCalories: total,
  };
  console.log('[healthkit] returning:', JSON.stringify(result));
  return result;
}

// ─── getTodayHealthData — simple numeric values (used by home.tsx) ────────────

export async function getTodayHealthData(): Promise<HealthData> {
  if (Platform.OS !== 'ios') {
    return {
      steps: null, activeCalories: null, totalCalories: null,
      restingHR: null, hrv: null, sleepHours: null, exerciseMinutes: null,
      lastActiveCalSync: null,
    };
  }

  const now  = new Date();
  const today = todayStart();

  const [stepsR, activeR, basalR, restingR, hrvR, sleepR, exerciseR, lastSyncR] =
    await Promise.allSettled([
      new Promise<number | null>(resolve =>
        AppleHealthKit.getStepCount(
          { startDate: today.toISOString(), endDate: now.toISOString() },
          (err, r) => resolve(err ? null : Math.round(r?.value ?? 0))
        )),
      new Promise<number | null>(resolve =>
        AppleHealthKit.getActiveEnergyBurned(
          { startDate: today.toISOString(), endDate: now.toISOString() },
          (err, r) => resolve(err ? null : sumValues(r ?? []))
        )),
      new Promise<number | null>(resolve =>
        AppleHealthKit.getBasalEnergyBurned(
          { startDate: today.toISOString(), endDate: now.toISOString() },
          (err, r) => resolve(err ? null : sumValues(r ?? []))
        )),
      new Promise<number | null>(resolve =>
        AppleHealthKit.getRestingHeartRate(
          { date: now.toISOString() },
          (err, r) => { const v = Math.round(r?.value ?? 0); resolve(err || !v ? null : v); }
        )),
      new Promise<number | null>(resolve =>
        AppleHealthKit.getHeartRateVariabilitySamples(
          { startDate: daysAgo(1).toISOString(), endDate: now.toISOString(), ascending: false, limit: 1 },
          (err, r) => { const v = r?.[0]?.value; resolve(err || v == null ? null : Math.round(v)); }
        )),
      new Promise<number | null>(resolve => {
        const s = daysAgo(2); s.setHours(18, 0, 0, 0);
        AppleHealthKit.getSleepSamples(
          { startDate: s.toISOString(), endDate: now.toISOString() },
          (err, r) => {
            if (err || !r?.length) { resolve(null); return; }
            let ms = 0;
            for (const smp of r) {
              if (smp.value !== 0 && smp.value !== 2) {
                const f = new Date(smp.startDate).getTime();
                const t = new Date(smp.endDate).getTime();
                if (t > f) ms += t - f;
              }
            }
            const h = ms / (1000 * 60 * 60);
            resolve(h > 0.25 ? Math.round(h * 10) / 10 : null);
          }
        );
      }),
      new Promise<number | null>(resolve =>
        AppleHealthKit.getAppleExerciseTime(
          { startDate: today.toISOString(), endDate: now.toISOString() },
          (err, r) => {
            if (err || !r?.length) { resolve(null); return; }
            const t = sumValues(r);
            resolve(t > 0 ? t : null);
          }
        )),
      // Last active cal sample endDate — used for sync timestamp display
      new Promise<string | null>(resolve =>
        (AppleHealthKit as any).getSamples(
          { type: 'ActiveEnergyBurned', startDate: today.toISOString(), endDate: now.toISOString(), ascending: false, limit: 1 },
          (err: string, results: any[]) => {
            if (err || !results?.length) { resolve(null); return; }
            resolve(results[0]?.endDate ?? results[0]?.startDate ?? null);
          }
        )
      ),
    ]);

  const active = activeR.status === 'fulfilled' ? activeR.value : null;
  const basal  = basalR.status  === 'fulfilled' ? basalR.value  : null;

  return {
    steps:              stepsR.status    === 'fulfilled' ? stepsR.value    : null,
    activeCalories:     active,
    totalCalories:      (active ?? basal) != null ? (active ?? 0) + (basal ?? 0) : null,
    restingHR:          restingR.status  === 'fulfilled' ? restingR.value  : null,
    hrv:                hrvR.status      === 'fulfilled' ? hrvR.value      : null,
    sleepHours:         sleepR.status    === 'fulfilled' ? sleepR.value    : null,
    exerciseMinutes:    exerciseR.status === 'fulfilled' ? exerciseR.value : null,
    lastActiveCalSync:  lastSyncR.status === 'fulfilled' ? (lastSyncR.value as unknown as string | null) : null,
  };
}

// ─── Trend exports ────────────────────────────────────────────────────────────

export function getHRVTrend(days: number): Promise<DailyPoint[]> {
  if (Platform.OS !== 'ios') return Promise.resolve([]);
  return new Promise(resolve => {
    AppleHealthKit.getHeartRateVariabilitySamples(
      { startDate: daysAgo(days).toISOString(), endDate: new Date().toISOString(), ascending: true },
      (err, results) => {
        if (err || !results?.length) { resolve([]); return; }
        const byDate: Record<string, number> = {};
        for (const r of results) {
          const date = (r.startDate ?? '').slice(0, 10);
          if (date) byDate[date] = r.value;
        }
        resolve(Object.entries(byDate).map(([date, value]) => ({ date, value: Math.round(value) })));
      }
    );
  });
}

export function getRestingHRTrend(days: number): Promise<DailyPoint[]> {
  if (Platform.OS !== 'ios') return Promise.resolve([]);
  return new Promise(resolve => {
    AppleHealthKit.getRestingHeartRateSamples(
      { startDate: daysAgo(days).toISOString(), endDate: new Date().toISOString(), ascending: true },
      (err, results) => {
        if (err || !results?.length) { resolve([]); return; }
        const byDate: Record<string, number> = {};
        for (const r of results) {
          const date = (r.startDate ?? '').slice(0, 10);
          if (date) byDate[date] = r.value;
        }
        resolve(Object.entries(byDate).map(([date, value]) => ({ date, value: Math.round(value) })));
      }
    );
  });
}

// ─── getWorkoutHRDetail ───────────────────────────────────────────────────────

export async function getWorkoutHRDetail(
  workoutStartDate: string,
  workoutEndDate: string,
): Promise<WorkoutHRDetail> {
  const empty: WorkoutHRDetail = { avgHR: null, maxHR: null, minHR: null, avgHRLastPortion: null, hrSamples: [] };
  if (Platform.OS !== 'ios') return empty;

  const samples = await hkArray<HKSample>(cb =>
    AppleHealthKit.getHeartRateSamples(
      { startDate: workoutStartDate, endDate: workoutEndDate, ascending: true },
      (err, results) => {
        cb(err, err || !results ? [] : results as unknown as HKSample[]);
      },
    )
  );

  const values = samples.map(s => sampleNumericValue(s)).filter(v => v > 30 && v < 250);
  if (values.length === 0) return empty;

  const startMs   = new Date(workoutStartDate).getTime();
  const endMs     = new Date(workoutEndDate).getTime();
  const cutoff    = endMs - (endMs - startMs) * 0.20;
  const lastPart  = samples
    .filter(s => new Date(s.startDate ?? '').getTime() >= cutoff)
    .map(s => sampleNumericValue(s))
    .filter(v => v > 30 && v < 250);

  return {
    avgHR: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
    maxHR: Math.max(...values),
    minHR: Math.min(...values),
    avgHRLastPortion: lastPart.length > 0
      ? Math.round(lastPart.reduce((a, b) => a + b, 0) / lastPart.length)
      : null,
    hrSamples: values,
  };
}

// ─── getWorkoutPaceDetail ─────────────────────────────────────────────────────

export function getWorkoutPaceDetail(
  distanceKm: number,
  durationSeconds: number,
): WorkoutPaceDetail | null {
  if (!distanceKm || distanceKm <= 0 || !durationSeconds || durationSeconds <= 0) return null;
  const pacePerKm   = durationSeconds / distanceKm;
  const pacePerMile = pacePerKm * 1.60934;
  return { pacePerKm, pacePerMile, distanceKm, durationSeconds };
}

// ─── matchTimeTrial ───────────────────────────────────────────────────────────

export async function matchTimeTrial(params: {
  trialType: 'hyrox_8k' | 'gf_20min';
  date: string;
}): Promise<TimeTrialMatchResult> {
  if (Platform.OS !== 'ios') {
    return { workout: null, workouts: [], needsConfirmation: false, notFound: true };
  }

  const { trialType } = params;
  const now      = new Date();
  const since48h = new Date(now.getTime() - 48 * 60 * 60 * 1000);

  const raw = await queryWorkoutSamples(since48h.toISOString(), now.toISOString());

  const running = raw.filter((w: any) => {
    const t = String(w.workoutActivityType ?? w.type ?? '');
    return t === 'Running' || t === '37' || t.toLowerCase().includes('run');
  });

  const toSample = (w: any): WorkoutSample => {
    const ms  = new Date(w.endDate).getTime() - new Date(w.startDate).getTime();
    const dur = Math.round(ms / 1000);
    const distRaw = w.totalDistance ?? w.distance ?? null;
    const src  = getSampleSource(w) || w.sourceName || 'Apple Health';
    return {
      externalId:     w.uuid ?? w.id ?? `${src}-${w.startDate}`,
      type:           'run',
      startDate:      w.startDate,
      endDate:        w.endDate,
      durationMinutes: Math.round(dur / 60),
      durationSeconds: dur,
      distanceKm:     distRaw != null ? Math.round(distRaw * 100) / 100 : null,
      calories:       w.totalEnergyBurned ?? w.calories ?? null,
      source:         src,
      avgHr:          null,
      maxHr:          null,
      pacePerKm:      null,
      pacePerMile:    null,
      effortZone:     null,
    };
  };

  const matches: WorkoutSample[] = running
    .filter((w: any) => {
      const ms  = new Date(w.endDate).getTime() - new Date(w.startDate).getTime();
      const sec = ms / 1000;
      const dist = w.totalDistance ?? w.distance ?? null;
      if (trialType === 'hyrox_8k') {
        return dist != null && dist >= 7.8 && dist <= 8.3;
      } else {
        return sec >= 1080 && sec <= 1380;
      }
    })
    .map(toSample);

  if (matches.length === 0) {
    return { workout: null, workouts: [], needsConfirmation: false, notFound: true };
  }
  if (matches.length === 1) {
    return { workout: matches[0], workouts: matches, needsConfirmation: false, notFound: false };
  }
  return { workout: null, workouts: matches, needsConfirmation: true, notFound: false };
}

// ─── Workout type mapping ─────────────────────────────────────────────────────

const HK_WORKOUT_TYPE_MAP: Record<string, string> = {
  Running:                       'run',
  Cycling:                       'bike',
  TraditionalStrengthTraining:   'strength',
  FunctionalStrengthTraining:    'strength',
  HighIntensityIntervalTraining: 'hiit',
  Swimming:                      'swim',
  Rowing:                        'row',
  Hiking:                        'hike',
  Walking:                       'walk',
  Yoga:                          'yoga',
  CrossTraining:                 'cross',
};

export type WorkoutSample = {
  externalId: string;
  type: string;
  startDate: string;
  endDate: string;
  durationMinutes: number;
  durationSeconds: number;
  distanceKm: number | null;
  calories: number | null;
  source: string;
  avgHr: number | null;
  maxHr: number | null;
  pacePerKm: number | null;
  pacePerMile: number | null;
  effortZone: string | null;
};

export type WorkoutHRDetail = {
  avgHR: number | null;
  maxHR: number | null;
  minHR: number | null;
  avgHRLastPortion: number | null;
  hrSamples: number[];
};

export type WorkoutPaceDetail = {
  pacePerKm: number;
  pacePerMile: number;
  distanceKm: number;
  durationSeconds: number;
};

export type TimeTrialMatchResult =
  | { workout: WorkoutSample; workouts: WorkoutSample[]; needsConfirmation: false; notFound: false }
  | { workout: null; workouts: WorkoutSample[]; needsConfirmation: true; notFound: false }
  | { workout: null; workouts: []; needsConfirmation: false; notFound: true };

// Normalize workout fields across getAnchoredWorkouts and getSamples so downstream
// code can use a single consistent shape (startDate/endDate/workoutActivityType/uuid).
function normalizeRawWorkout(w: any): any {
  return {
    startDate:           w.startDate           ?? w.start,
    endDate:             w.endDate             ?? w.end,
    workoutActivityType: w.workoutActivityType  ?? w.activityName ?? w.type,
    uuid:                w.uuid                ?? w.id,
    duration:            w.duration,
    totalDistance:       w.totalDistance       ?? w.distance,
    totalEnergyBurned:   w.totalEnergyBurned   ?? w.calories,
    sourceName:          w.sourceName,
    metadata:            w.metadata,
  };
}

// Primary method: getAnchoredWorkouts (react-native-health v1.19+).
// Falls back to getSamples type="Workout" if unavailable or returns empty.
async function queryWorkoutSamples(startDate: string, endDate: string): Promise<any[]> {
  const opts = { startDate, endDate, limit: 50 };

  if (typeof (AppleHealthKit as any).getAnchoredWorkouts === 'function') {
    console.log('[workouts] trying getAnchoredWorkouts()');
    const result = await new Promise<any>(resolve => {
      (AppleHealthKit as any).getAnchoredWorkouts(opts, (err: string, res: any) => {
        if (err) { console.log('[workouts] getAnchoredWorkouts error:', err); resolve(null); return; }
        resolve(res);
      });
    });
    const data: any[] = result?.data ?? [];
    console.log('[workouts] getAnchoredWorkouts() count:', data.length);
    if (data.length > 0) {
      console.log('[workouts] successful query method: getAnchoredWorkouts()');
      console.log('[workouts] first sample keys:', Object.keys(data[0] ?? {}));
      console.log('[workouts] first sample:', JSON.stringify(data[0]));
      const s = data[0];
      console.log('[workouts] distance field check - distance:', s.distance, 'totalDistance:', s.totalDistance, 'distanceInMeters:', s.distanceInMeters);
      return data.map(normalizeRawWorkout);
    }
  } else {
    console.log('[workouts] getAnchoredWorkouts not available — available methods:',
      Object.keys(AppleHealthKit as any).filter(k => typeof (AppleHealthKit as any)[k] === 'function').join(', '));
  }

  // Fallback: getSamples with type strings
  for (const typeStr of ['Workout', 'Workouts']) {
    console.log('[workouts] fallback trying getSamples type:', typeStr);
    const results = await hkArray<any>(cb =>
      (AppleHealthKit as any).getSamples({ ...opts, ascending: false, type: typeStr }, cb)
    );
    console.log(`[workouts] getSamples("${typeStr}") count:`, results.length);
    if (results.length > 0) {
      console.log('[workouts] successful fallback: getSamples type="' + typeStr + '"');
      return results.map(normalizeRawWorkout);
    }
  }

  console.log('[workouts] all query methods returned 0 results');
  return [];
}

// ─── Workout deduplication ────────────────────────────────────────────────────
// When multiple wearables record the same session, keep only the best-source one.

function pickBestWorkoutSource(group: any[]): any | null {
  const src = (w: any) => (w.sourceName ?? '').toLowerCase();
  const checks: Array<(w: any) => boolean> = [
    w => src(w).includes('garmin'),
    w => src(w).includes('coros'),
    w => src(w).includes('zepp') || src(w).includes('amazfit'),
    w => src(w).includes('polar'),
    w => src(w).includes('whoop'),
    w => src(w).includes('apple watch') || src(w).endsWith(' watch'),
  ];
  for (const check of checks) {
    const match = group.find(check);
    if (match) return match;
  }
  return null; // iPhone / unknown — skip entirely
}

function sameWorkoutType(a: string, b: string): boolean {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al.includes('run')      && bl.includes('run'))      return true;
  if (al.includes('cycl')     && bl.includes('cycl'))     return true;
  if (al.includes('strength') && bl.includes('strength')) return true;
  if (al.includes('walk')     && bl.includes('walk'))     return true;
  return al === bl;
}

function deduplicateWorkouts(workouts: any[]): any[] {
  const used = new Set<number>();
  const result: any[] = [];

  for (let i = 0; i < workouts.length; i++) {
    if (used.has(i)) continue;
    const group  = [workouts[i]];
    const aType  = workouts[i].workoutActivityType ?? '';
    const aStart = new Date(workouts[i].startDate).getTime();

    for (let j = i + 1; j < workouts.length; j++) {
      if (used.has(j)) continue;
      const bType       = workouts[j].workoutActivityType ?? '';
      const bStart      = new Date(workouts[j].startDate).getTime();
      const diffMinutes = Math.abs(aStart - bStart) / 1000 / 60;
      const typeMatch   = sameWorkoutType(aType, bType);
      const within60    = diffMinutes < 60;
      console.log('[workouts] comparing:', {
        typeA: aType, typeB: bType, sameType: typeMatch,
        startA: workouts[i].startDate, startB: workouts[j].startDate,
        diffMinutes: Math.round(diffMinutes * 10) / 10,
      });
      if (typeMatch && within60) {
        group.push(workouts[j]);
        used.add(j);
      }
    }

    used.add(i);
    const best = pickBestWorkoutSource(group);
    if (best) result.push(best);
  }

  console.log('[workouts] deduplication: found', result.length, 'unique sessions from', workouts.length, 'raw workouts');
  console.log('[workouts] selected sources:', result.map((w: any) => w.sourceName ?? 'unknown'));
  return result;
}

export async function fetchTodayWorkouts(userId?: string): Promise<WorkoutSample[]> {
  if (Platform.OS !== 'ios') return [];

  console.log('[workouts] starting fetchTodayWorkouts');
  const now       = new Date();
  const start48h  = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const startDate = start48h.toISOString();
  const endDate   = now.toISOString();
  console.log('[workouts] date range (48h):', startDate, 'to', endDate);

  const raw = await queryWorkoutSamples(startDate, endDate);
  console.log('[workouts] raw getSamples result count:', raw.length);

  const filtered = raw.filter((w: any) => {
    // Duration: use duration field if present (HK stores seconds), otherwise calc from timestamps
    const durationSeconds = w.duration != null
      ? Number(w.duration)
      : (new Date(w.endDate).getTime() - new Date(w.startDate).getTime()) / 1000;
    console.log('[workouts] workout duration seconds:', durationSeconds, 'type:', w.workoutActivityType ?? w.type, 'source:', w.sourceName);
    return durationSeconds > 600; // 10 minutes
  });

  console.log('[workouts] filtered count (>10 min):', filtered.length);

  const deduped = deduplicateWorkouts(filtered);

  // Optionally fetch user zones for effort classification
  let userZones: UserZones | null = null;
  if (userId) {
    const { data: zoneProfile } = await supabase
      .from('profiles')
      .select('threshold_hr, z1_max_hr, z2_max_hr, z3_max_hr, z4_max_hr')
      .eq('id', userId)
      .maybeSingle();
    if (zoneProfile) {
      userZones = {
        threshold_hr: (zoneProfile as any).threshold_hr ?? null,
        z1_max_hr:    (zoneProfile as any).z1_max_hr    ?? null,
        z2_max_hr:    (zoneProfile as any).z2_max_hr    ?? null,
        z3_max_hr:    (zoneProfile as any).z3_max_hr    ?? null,
        z4_max_hr:    (zoneProfile as any).z4_max_hr    ?? null,
      };
    }
  }

  return Promise.all(deduped.map(async (w: any) => {
    // Duration — prefer the 'duration' field (seconds), fall back to timestamp diff
    const durationSeconds = w.duration != null
      ? Math.round(Number(w.duration))
      : Math.round((new Date(w.endDate).getTime() - new Date(w.startDate).getTime()) / 1000);
    const durationMinutes = Math.round(durationSeconds / 60);

    const hkType  = w.workoutActivityType ?? w.type ?? 'Other';
    const type    = HK_WORKOUT_TYPE_MAP[String(hkType)] ?? 'other';
    const source  = getSampleSource(w) || w.sourceName || 'Apple Health';

    // Distance — getAnchoredWorkouts returns miles; convert to km for internal storage
    const distRaw = w.totalDistance ?? w.distance ?? w.distanceKm ?? w.totalDistanceInMeters ?? null;
    let distKm: number | null = null;
    if (distRaw != null) {
      const rawMiles = Number(distRaw);
      distKm = Math.round(rawMiles * 1.60934 * 100) / 100; // miles → km
      console.log('[workouts] raw distance (miles):', rawMiles, 'converted to km:', distKm);
    }

    const calories = w.totalEnergyBurned ?? w.calories ?? null;

    // HR enrichment
    const hrDetail = await getWorkoutHRDetail(w.startDate, w.endDate);

    // Pace
    const pacePerKm   = distKm && distKm > 0 ? durationSeconds / distKm : null;
    const pacePerMile = pacePerKm != null ? pacePerKm * 1.60934 : null;

    // Effort zone
    let effortZone: string | null = null;
    if (hrDetail.avgHR != null && userZones) {
      effortZone = classifyEffort(hrDetail.avgHR, userZones);
    }

    return {
      externalId:     w.uuid ?? w.id ?? `${source}-${w.startDate}`,
      type,
      startDate:      w.startDate,
      endDate:        w.endDate,
      durationMinutes,
      durationSeconds,
      distanceKm:     distKm,
      calories:       calories != null ? Math.round(calories) : null,
      source,
      avgHr:          hrDetail.avgHR,
      maxHr:          hrDetail.maxHR,
      pacePerKm,
      pacePerMile,
      effortZone,
    };
  }));
}
