import AsyncStorage from '@react-native-async-storage/async-storage';

const PEAK65_API = process.env.EXPO_PUBLIC_API_URL || 'https://peak65.vercel.app';
const CACHE_KEY_EVENTS = 'peak65_hyrox_events_v1';
const CACHE_TTL = 24 * 60 * 60 * 1000;

export interface HyroxEvent {
  season: number;
  location: string;
  year: number;
}

export interface DivisionStats {
  division: string;
  athlete_count: number;
  median_time: string;
  p75_time: string;
  p90_time: string;
}

export interface AthleteSearchResult {
  athlete_name: string;
  season: number;
  location: string;
  division: string;
  gender: string;
  age_group: string;
  finish_time: string;
  station_splits: Record<string, string>;
  run_splits: Record<string, string>;
  roxzone_time: string;
}

export interface StationSplits {
  ski_erg: string;
  sled_push: string;
  sled_pull: string;
  burpee_broad_jumps: string;
  row_erg: string;
  farmers_carry: string;
  sandbag_lunges: string;
  wall_balls: string;
}

export interface AthleteRaceResult {
  id: string;
  event_name: string;
  event_city: string;
  division: string;
  date: string;
  finish_time: string;
  splits: StationSplits;
}

export interface HyroxAthlete {
  id: string;
  name: string;
  nationality?: string;
  results?: AthleteRaceResult[];
}

export type DivisionPreset = { label: string; percentile: string; time: string };

const DIVISION_PRESET_MAP: Record<string, DivisionPreset[]> = {
  'men-open':           [{ label: 'Finish Strong', percentile: 'Top 50%', time: '1:30' }, { label: 'Competitive', percentile: 'Top 25%', time: '1:15' }, { label: 'Elite', percentile: 'Top 10%', time: '1:05' }],
  'women-open':         [{ label: 'Finish Strong', percentile: 'Top 50%', time: '1:45' }, { label: 'Competitive', percentile: 'Top 25%', time: '1:30' }, { label: 'Elite', percentile: 'Top 10%', time: '1:18' }],
  'men-pro':            [{ label: 'Finish Strong', percentile: 'Top 50%', time: '1:10' }, { label: 'Competitive', percentile: 'Top 25%', time: '1:03' }, { label: 'Elite', percentile: 'Top 10%', time: '0:58' }],
  'women-pro':          [{ label: 'Finish Strong', percentile: 'Top 50%', time: '1:22' }, { label: 'Competitive', percentile: 'Top 25%', time: '1:14' }, { label: 'Elite', percentile: 'Top 10%', time: '1:08' }],
  'men-open-doubles':   [{ label: 'Finish Strong', percentile: 'Top 50%', time: '1:12' }, { label: 'Competitive', percentile: 'Top 25%', time: '1:02' }, { label: 'Elite', percentile: 'Top 10%', time: '0:56' }],
  'women-open-doubles': [{ label: 'Finish Strong', percentile: 'Top 50%', time: '1:22' }, { label: 'Competitive', percentile: 'Top 25%', time: '1:10' }, { label: 'Elite', percentile: 'Top 10%', time: '1:03' }],
  'men-pro-doubles':    [{ label: 'Finish Strong', percentile: 'Top 50%', time: '1:02' }, { label: 'Competitive', percentile: 'Top 25%', time: '0:56' }, { label: 'Elite', percentile: 'Top 10%', time: '0:52' }],
  'women-pro-doubles':  [{ label: 'Finish Strong', percentile: 'Top 50%', time: '1:18' }, { label: 'Competitive', percentile: 'Top 25%', time: '1:08' }, { label: 'Elite', percentile: 'Top 10%', time: '1:02' }],
  'mixed-doubles':      [{ label: 'Finish Strong', percentile: 'Top 50%', time: '1:15' }, { label: 'Competitive', percentile: 'Top 25%', time: '1:05' }, { label: 'Elite', percentile: 'Top 10%', time: '0:58' }],
};

export function getDivisionPresets(division: string): DivisionPreset[] {
  return DIVISION_PRESET_MAP[division] ?? DIVISION_PRESET_MAP['men-open'];
}

export async function fetchEvents(): Promise<HyroxEvent[]> {
  try {
    const cached = await AsyncStorage.getItem(CACHE_KEY_EVENTS);
    if (cached) {
      const { ts, data } = JSON.parse(cached);
      if (Date.now() - ts < CACHE_TTL) return data;
    }
    const res = await fetch(`${PEAK65_API}/api/hyrox/events`);
    console.log('[hyroxApi] fetchEvents status:', res.status, 'url:', `${PEAK65_API}/api/hyrox/events`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    console.log('[hyroxApi] fetchEvents raw json:', JSON.stringify(json).slice(0, 500));
    const events: HyroxEvent[] = Array.isArray(json.data) ? json.data : [];
    console.log('[hyroxApi] fetchEvents parsed events length:', events.length);
    console.log('[hyroxApi] fetchEvents first event:', JSON.stringify(events[0], null, 2));
    await AsyncStorage.setItem(CACHE_KEY_EVENTS, JSON.stringify({ ts: Date.now(), data: events }));
    return events;
  } catch (err) {
    console.log('[hyroxApi] fetchEvents caught error:', err);
    return [];
  }
}

export async function fetchDivisionStats(division: string): Promise<DivisionStats | null> {
  const presets = getDivisionPresets(division);
  return { division, athlete_count: 0, median_time: presets[0].time, p75_time: presets[1].time, p90_time: presets[2].time };
}

export async function searchAthletes(firstName: string, lastName: string): Promise<AthleteSearchResult[]> {
  try {
    const res = await fetch(`${PEAK65_API}/api/hyrox/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName, lastName }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return Array.isArray(json.data) ? (json.data as AthleteSearchResult[]) : [];
  } catch {
    return [];
  }
}

export async function fetchAthleteResults(firstName: string, lastName: string): Promise<HyroxAthlete | null> {
  try {
    const res = await fetch(`${PEAK65_API}/api/hyrox/athlete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName, lastName }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return json.data ?? null;
  } catch {
    return null;
  }
}

export function weeksFromToday(dateStr: string): number {
  const ms = new Date(dateStr).getTime() - Date.now();
  return Math.round(ms / (7 * 24 * 60 * 60 * 1000));
}

export function parseTimeToSecs(t: string): number {
  const parts = t.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}
