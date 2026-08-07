import AsyncStorage from '@react-native-async-storage/async-storage';

// Every AsyncStorage key holding data that belongs to the signed-in athlete.
// Cleared on sign-out so the next account on this device can never inherit the
// previous athlete's program, sessions, or dismissed prompts.
const USER_CACHE_KEYS = [
  'home_cache',                  // today's program day, streak, session count
  'program_cache',               // full program list + profile snapshot
  'history_cache',               // session logs, check-ins, external workouts
  'countup_date',                // per-athlete stat count-up animation marker
  'last_missed_check',           // per-athlete missed-session prompt marker
  'dismissed_next_week_banner',  // per-athlete UI dismissal
];

// Tooltip dismissals are written one key per tooltip as `peak65_tooltip_<id>`,
// so they have to be matched by prefix rather than listed.
const USER_CACHE_PREFIXES = ['peak65_tooltip_'];

// Deliberately NOT cleared:
//   peak65_hyrox_events_v1 — public HYROX event list, identical for every user
//   sb-*                   — Supabase auth storage, owned by supabase.auth itself;
//                            removing it by hand can leave the client inconsistent
export async function clearUserCache(): Promise<void> {
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const prefixed = allKeys.filter(k => USER_CACHE_PREFIXES.some(p => k.startsWith(p)));
    const toRemove = [...USER_CACHE_KEYS, ...prefixed];
    if (toRemove.length > 0) await AsyncStorage.multiRemove(toRemove);
    console.log('[clearUserCache] cleared', toRemove.length, 'keys');
  } catch (err) {
    console.log('[clearUserCache] error:', err);
  }
}
