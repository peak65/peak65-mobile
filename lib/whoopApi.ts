import { supabase } from './supabase';
import type { WearableHealthData } from './healthKit';

const WHOOP_CLIENT_ID     = 'feb420a0-c020-4492-87db-44dd37c45578';
const WHOOP_CLIENT_SECRET = 'eb7b4cd154890f79b019fe28604b90dd4d6cf5b5f4f04a3d153deeb0a447deac';
const REDIRECT_URI = 'peak65://auth/whoop/callback';
const AUTH_BASE    = 'https://api.prod.whoop.com/oauth/oauth2';
const API_BASE     = 'https://api.prod.whoop.com/developer'; // no version prefix — endpoints include /v2/
const SCOPES       = 'read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement offline';

// ─── Types ────────────────────────────────────────────────────────────────────

export type WhoopRecovery = {
  hrv: number | null;
  rhr: number | null;
  recoveryScore: number | null;
  userCalibrating: boolean | null;
};

export type WhoopSleep = {
  totalSleepMs: number | null;
  sleepPerformance: number | null;
};

export type WhoopWorkout = {
  id: number;
  start: string;
  end: string;
  sportId: number;
  avgHr: number | null;
  maxHr: number | null;
  kilojoule: number | null;
  distanceMeters: number | null;
  durationSeconds: number;
};

export type WhoopCycle = {
  steps: number | null;
  strainKj: number | null;
  totalKcal: number | null;
  cycleStart: string | null;
};

export type WhoopAllData = {
  recovery: WhoopRecovery | null;
  sleep: WhoopSleep | null;
  workouts: WhoopWorkout[];
  cycle: WhoopCycle | null;
};

// ─── Auth URL ─────────────────────────────────────────────────────────────────

let pendingOAuthState = '';

export function getPendingOAuthState(): string {
  return pendingOAuthState;
}

export function getWhoopAuthUrl(): string {
  const state = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
  pendingOAuthState = state;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     WHOOP_CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    scope:         SCOPES,
    state,
  });
  return `${AUTH_BASE}/auth?${params.toString()}`;
}

// ─── Token exchange ───────────────────────────────────────────────────────────

export async function exchangeWhoopCode(code: string, userId: string): Promise<void> {
  console.log('[whoop] exchangeWhoopCode called with code:', code.substring(0, 10) + '...');
  console.log('[whoop] token request body:', {
    grant_type:   'authorization_code',
    code:         code.substring(0, 10) + '...',
    client_id:    WHOOP_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
  });

  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      client_id:     WHOOP_CLIENT_ID,
      client_secret: WHOOP_CLIENT_SECRET,
      redirect_uri:  REDIRECT_URI,
    }).toString(),
  });

  console.log('[whoop] token response status:', res.status);
  const responseText = await res.text();
  console.log('[whoop] token response body:', responseText);

  if (!res.ok) throw new Error(`Whoop token exchange failed (${res.status}): ${responseText}`);

  let json: any;
  try {
    json = JSON.parse(responseText);
  } catch (e) {
    console.log('[whoop] failed to parse token response as JSON');
    throw new Error('Token exchange failed: ' + responseText);
  }

  console.log('[whoop] token response keys:', Object.keys(json));
  console.log('[whoop] access_token present:', !!json.access_token);
  console.log('[whoop] access_token length:', json.access_token?.length ?? 0);
  console.log('[whoop] refresh_token present:', !!json.refresh_token);
  console.log('[whoop] token_type:', json.token_type);
  console.log('[whoop] expires_in:', json.expires_in);

  const expiry = new Date(Date.now() + (json.expires_in as number) * 1000).toISOString();
  const { data: upsertData, error: upsertError } = await supabase.from('profiles').update({
    whoop_access_token:  json.access_token,
    whoop_refresh_token: json.refresh_token,
    whoop_token_expiry:  expiry,
    whoop_connected:     true,
  }).eq('id', userId).select();
  console.log('[whoop] supabase update error:', upsertError?.message ?? null);
  console.log('[whoop] supabase update rows affected:', upsertData?.length ?? 0);
  if (upsertError) throw new Error(`Failed to save Whoop tokens to Supabase: ${upsertError.message}`);
}

// ─── Token refresh ────────────────────────────────────────────────────────────

async function clearWhoopTokens(userId: string): Promise<void> {
  console.log('[whoop] token refresh failed — user needs to reconnect');
  await supabase.from('profiles').update({
    whoop_connected:    false,
    whoop_access_token: null,
  }).eq('id', userId);
}

async function refreshWhoopToken(userId: string): Promise<string> {
  const { data: p } = await supabase
    .from('profiles')
    .select('whoop_refresh_token')
    .eq('id', userId)
    .maybeSingle();
  if (!p?.whoop_refresh_token) throw new Error('No Whoop refresh token');

  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: p.whoop_refresh_token as string,
      client_id:     WHOOP_CLIENT_ID,
      client_secret: WHOOP_CLIENT_SECRET,
    }).toString(),
  });

  if (res.status === 401 || res.status === 400) {
    await clearWhoopTokens(userId);
    throw new Error('Whoop refresh token expired — user needs to reconnect');
  }
  if (!res.ok) throw new Error(`Whoop token refresh failed: ${res.status}`);

  const json = await res.json();
  const expiry = new Date(Date.now() + (json.expires_in as number) * 1000).toISOString();
  console.log('[whoop] token refreshed successfully, new expiry:', expiry);
  await supabase.from('profiles').update({
    whoop_access_token:  json.access_token,
    whoop_refresh_token: json.refresh_token,
    whoop_token_expiry:  expiry,
    whoop_connected:     true,
  }).eq('id', userId);
  return json.access_token as string;
}

// ─── Get valid token — proactively refresh if within 1 hour of expiry ─────────

async function getValidToken(userId: string): Promise<string> {
  const { data: p } = await supabase
    .from('profiles')
    .select('whoop_access_token, whoop_refresh_token, whoop_token_expiry')
    .eq('id', userId)
    .maybeSingle();

  const accessToken  = p?.whoop_access_token  as string | null ?? null;
  const refreshToken = p?.whoop_refresh_token as string | null ?? null;
  const expiryRaw    = p?.whoop_token_expiry  as string | null ?? null;

  console.log('[whoop] getValidToken: accessToken present:', !!accessToken, '| refreshToken present:', !!refreshToken, '| expiryRaw:', expiryRaw);

  if (!accessToken && refreshToken) {
    console.log('[whoop] no access token but refresh token exists — refreshing now');
    return refreshWhoopToken(userId);
  }
  if (!accessToken) throw new Error('No Whoop access token — user needs to reconnect');

  // If expiry is null/unknown, use Infinity so we skip the proactive refresh and
  // let the existing token be tried. A 401 in whoopGet will trigger a refresh then.
  // Previously defaulted to 0, which made Date.now() >= 0 always true → infinite
  // refresh loop that burned the refresh token and silently cleared whoop_connected.
  const expiry = expiryRaw ? new Date(expiryRaw).getTime() : Infinity;
  const msUntilExpiry = expiry - Date.now();

  console.log('[whoop] token expiry:', expiryRaw ?? 'null (treating as valid)', '| msUntilExpiry:', msUntilExpiry, '| willProactiveRefresh:', msUntilExpiry < 5 * 60 * 1000);

  // Refresh only when within 5 minutes of expiry.
  if (msUntilExpiry < 5 * 60 * 1000) {
    console.log('[whoop] token within 5-min window — refreshing proactively');
    return refreshWhoopToken(userId);
  }
  return accessToken;
}

// ─── API request — 401 triggers one refresh attempt, then clears tokens ───────

async function whoopGet(endpoint: string, userId: string): Promise<any> {
  const token = await getValidToken(userId);
  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401) {
    console.log('[whoop] 401 on', endpoint, '— attempting token refresh');
    try {
      const newToken = await refreshWhoopToken(userId);
      const res2 = await fetch(`${API_BASE}${endpoint}`, {
        headers: { Authorization: `Bearer ${newToken}` },
      });
      if (res2.status === 401) {
        throw new Error(`Whoop API ${endpoint} still 401 after refresh`);
      }
      if (!res2.ok) throw new Error(`Whoop API ${endpoint} failed after refresh: ${res2.status}`);
      return res2.json();
    } catch (e) {
      throw e;
    }
  }

  if (!res.ok) throw new Error(`Whoop API ${endpoint} failed: ${res.status}`);
  return res.json();
}

// ─── Data fetchers ────────────────────────────────────────────────────────────

export async function fetchWhoopRecovery(userId: string): Promise<WhoopRecovery | null> {
  try {
    const data = await whoopGet('/v2/recovery?limit=1', userId);
    console.log('[whoop] v2 recovery raw response:', JSON.stringify(data).substring(0, 500));
    const record = data?.records?.[0];
    if (!record?.score) return null;
    return {
      hrv:             record.score.hrv_rmssd_milli    ?? null,
      rhr:             record.score.resting_heart_rate ?? null,
      recoveryScore:   record.score.recovery_score     ?? null,
      userCalibrating: record.score.user_calibrating   ?? null,
    };
  } catch (e) {
    console.log('[whoop] fetchWhoopRecovery error:', e);
    return null;
  }
}

export async function fetchWhoopSleep(userId: string): Promise<WhoopSleep | null> {
  try {
    const data = await whoopGet('/v2/activity/sleep?limit=1', userId);
    console.log('[whoop] v2 sleep raw response:', JSON.stringify(data).substring(0, 500));
    const record = data?.records?.[0];
    if (!record?.score) return null;
    const stages = record.score.stage_summary;
    const totalSleepMs = stages
      ? (stages.total_light_sleep_time_milli    ?? 0) +
        (stages.total_slow_wave_sleep_time_milli ?? 0) +
        (stages.total_rem_sleep_time_milli       ?? 0)
      : null;
    return {
      totalSleepMs,
      sleepPerformance: record.score.sleep_performance_percentage ?? null,
    };
  } catch (e) {
    console.log('[whoop] fetchWhoopSleep error:', e);
    return null;
  }
}

export async function fetchWhoopWorkouts(userId: string): Promise<WhoopWorkout[]> {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const since = todayStart.toISOString();
    const data  = await whoopGet(`/v2/activity/workout?limit=25&start=${since}`, userId);
    console.log('[whoop] v2 workout raw response:', JSON.stringify(data).substring(0, 500));
    const records: any[] = data?.records ?? [];
    return records.map(r => {
      const start = r.start ?? '';
      const end   = r.end   ?? '';
      const durationMs = start && end
        ? new Date(end).getTime() - new Date(start).getTime()
        : 0;
      return {
        id:              r.id,
        start,
        end,
        sportId:         r.sport_id              ?? 0,
        avgHr:           r.score?.average_heart_rate ?? null,
        maxHr:           r.score?.max_heart_rate     ?? null,
        kilojoule:       r.score?.kilojoule          ?? null,
        distanceMeters:  r.score?.distance_meter     ?? null,
        durationSeconds: Math.round(durationMs / 1000),
      };
    });
  } catch (e) {
    console.log('[whoop] fetchWhoopWorkouts error:', e);
    return [];
  }
}

export async function fetchWhoopCycle(userId: string): Promise<WhoopCycle | null> {
  try {
    const data = await whoopGet('/v1/cycle?limit=1', userId);
    console.log('[whoop] v1 cycle full raw response:', JSON.stringify(data).substring(0, 800));
    // v1 cycle API returns { data: [...] }, not { records: [...] }
    const record = data?.data?.[0] ?? data?.records?.[0];
    console.log('[whoop] v1 cycle data[0]?.score?.step_count:', data?.data?.[0]?.score?.step_count);
    if (!record?.score) {
      console.log('[whoop] cycle: no score in record:', JSON.stringify(record ?? {}).substring(0, 200));
      return null;
    }
    const steps     = record.score.step_count ?? null;
    const totalKcal = record.score.kilojoule != null ? Math.round(record.score.kilojoule / 4.184) : null;
    console.log('[whoop] cycle score.step_count:', steps, '| kilojoule:', record.score.kilojoule, '| totalKcal:', totalKcal);
    return {
      steps,
      strainKj:   record.score.kilojoule ?? null,
      totalKcal,
      cycleStart: record.start ?? null,
    };
  } catch (e) {
    console.log('[whoop] fetchWhoopCycle error:', e);
    return null;
  }
}

export async function fetchAllWhoopData(userId: string): Promise<WhoopAllData> {
  const [recovery, sleep, workouts, cycle] = await Promise.all([
    fetchWhoopRecovery(userId),
    fetchWhoopSleep(userId),
    fetchWhoopWorkouts(userId),
    fetchWhoopCycle(userId),
  ]);
  return { recovery, sleep, workouts, cycle };
}

// ─── Workout upsert ───────────────────────────────────────────────────────────

const WHOOP_SPORT_MAP: Record<number, string> = {
  1:   'run',
  2:   'bike',
  3:   'row',
  71:  'strength',
  72:  'hiit',
  80:  'swim',
  126: 'hike',
  170: 'walk',
  '-1': 'other',
} as any;

export async function upsertWhoopWorkouts(userId: string, workouts: WhoopWorkout[]): Promise<void> {
  const rows = workouts
    .filter(w => w.durationSeconds > 600)
    .map(w => ({
      user_id:          userId,
      external_id:      `whoop-${w.id}`,
      workout_type:     WHOOP_SPORT_MAP[w.sportId] ?? 'other',
      start_time:       w.start,
      end_time:         w.end,
      duration_minutes: Math.round(w.durationSeconds / 60),
      distance_km:      w.distanceMeters != null ? Math.round(w.distanceMeters / 10) / 100 : null,
      calories:         w.kilojoule != null ? Math.round(w.kilojoule / 4.184) : null,
      source:           'Whoop',
      avg_hr:           w.avgHr,
      max_hr:           w.maxHr,
      pace_per_km:      null,
      effort_zone:      null,
    }));
  if (!rows.length) return;
  await supabase.from('external_workouts').upsert(rows, { onConflict: 'user_id,external_id' });
  console.log('[whoop] upserted', rows.length, 'workouts to external_workouts');
}

// ─── mergeWhoopIntoHealthData ─────────────────────────────────────────────────
// Overlays Whoop readings into healthData. Sets activeCalories from Whoop strain
// (sum of workout kilojoules). totalCalories = TDEE base + strain is computed
// downstream in the TDEE block (profile.tsx / home.tsx) — not set here.

export function mergeWhoopIntoHealthData(
  healthData: WearableHealthData,
  whoopData: WhoopAllData,
): WearableHealthData {
  const merged = { ...healthData };
  const r = whoopData.recovery;

  if (r) {
    if (r.hrv != null) {
      merged.hrv = { value: r.hrv, source: 'Whoop' };
      console.log('[whoop] merge: hrv:', r.hrv);
    }
    if (r.rhr != null) {
      merged.restingHR = { value: r.rhr, source: 'Whoop' };
      console.log('[whoop] merge: rhr:', r.rhr);
    }
  }

  // Strain calories = sum of individual workout kilojoules — this is the active portion.
  // TDEE block will add its basal estimate on top to produce totalCalories.
  const strainKj   = whoopData.workouts.reduce((s, w) => s + (w.kilojoule ?? 0), 0);
  const strainKcal = Math.round(strainKj / 4.184);
  merged.activeCalories = { value: strainKcal, source: 'Whoop' };
  console.log('[whoop] merge: activeCalories:', strainKcal, 'from kilojoules:', strainKj);

  const s = whoopData.sleep;
  if (s?.totalSleepMs != null && s.totalSleepMs > 0) {
    const hours = Math.round(s.totalSleepMs / (1_000 * 60 * 60) * 10) / 10;
    if (hours > 0.25) {
      merged.sleepHours = { value: hours, source: 'Whoop' };
      console.log('[whoop] merge: sleepHours:', hours);
    }
  }

  // Steps from the Whoop daily cycle endpoint (/v1/cycle)
  const cycle = whoopData.cycle;
  if (cycle?.steps != null) {
    merged.steps = { value: cycle.steps, source: 'Whoop' };
    console.log('[whoop] merge: steps from cycle:', cycle.steps);
  }

  // Total daily calorie burn from cycle (includes resting + strain — use as Total, not Active)
  console.log('[whoop] merge: cycle totalKcal raw:', cycle?.totalKcal ?? null, '| activeCalories (strain):', merged.activeCalories?.value ?? null);
  if (cycle?.totalKcal != null && cycle.totalKcal > 0) {
    merged.totalCalories = { value: cycle.totalKcal, source: 'Whoop' };
    console.log('[whoop] merge: totalCalories set to Whoop cycle total:', cycle.totalKcal);
  }

  return merged;
}
