import React, { useState, useCallback, useRef, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { CompositeNavigationProp } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  View, Text, ScrollView, TouchableOpacity, RefreshControl,
  StyleSheet, ActivityIndicator, Modal, AppState, Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Zap, Target, Activity, Moon, Heart, Flame, Dumbbell } from 'lucide-react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { supabase } from '../../lib/supabase';
import {
  getTodayHealthData, fetchTodayHealthData, fetchTodayWorkouts,
  type HealthData, type WearableHealthData,
} from '../../lib/healthKit';
import { computeTDEEFromProfile, getActivityMultiplier } from '../../lib/tdee';
import { calculatePeakScore, type PeakScoreResult } from '../../lib/peakScore';
import {
  getConnectedWearables,
  selectHRVSource, selectRHRSource,
  selectSleepSource, resolveAllSources,
} from '../../lib/wearablePriority';
import type { Program, ProgramDay, ProgramSession, ExerciseItem, TabParamList, MainStackParamList } from '../_layout';
import { ProgramStatusContext } from '../_layout';
import { useCoachName } from '../../lib/useCoachName';
import { detectCandidates, getPendingCandidates, type CandidateRow } from '../../lib/sessionMatcher';
import WorkoutConfirmationCard from '../../components/WorkoutConfirmationCard';
import { Logo } from '../../components/Logo';
import { Colors, Fonts, scoreColor } from '../../lib/theme';
import { Flags } from '../../lib/flags';

// ─── Constants ────────────────────────────────────────────────────────────────

const MILESTONES: Record<number, { emoji: string; message: string; sub: string }> = {
  1:   { emoji: '🏆', message: 'First one down. The journey starts now.', sub: 'Session 1 complete.' },
  5:   { emoji: '🔥', message: '5 sessions. Consistency is forming.',      sub: 'Keep showing up.' },
  10:  { emoji: '⚡', message: "10 sessions. You're building something real.", sub: 'Double digits.' },
  25:  { emoji: '💪', message: "25 sessions. You're not who you were.",   sub: 'A quarter century.' },
  50:  { emoji: '🚀', message: '50 sessions. Half way to triple digits.',  sub: 'Unstoppable.' },
  100: { emoji: '👑', message: '100 sessions. Elite mindset. Proven.',     sub: 'Triple digits.' },
};

const WORKOUT_TYPE_LABELS: Record<string, string> = {
  run:      'Running',
  bike:     'Cycling',
  strength: 'Strength Training',
  hiit:     'HIIT',
  swim:     'Swimming',
  row:      'Rowing',
  hike:     'Hiking',
  walk:     'Walking',
  yoga:     'Yoga',
  cross:    'Cross Training',
  other:    'Workout',
};

// ─── Types ────────────────────────────────────────────────────────────────────

type HomeProfile = {
  wearable_connected: boolean | null;
  wearable_type: string | null;
  apple_health_connected: boolean | null;
  goal: string | null;
  chest_strap_tip_shown: boolean | null;
  coached_upsell_dismissed: boolean | null;
  whoop_connected: boolean | null;
  garmin_connected: boolean | null;
  coros_connected: boolean | null;
  manual_hrv: number | null;
  manual_hrv_date: string | null;
  program_start_date: string | null;
  goal_time: string | null;
  weight_kg: number | null;
  weight: string | null;
  units: string | null;
  preferred_units: string | null;
  body_weight: number | null;
  weight_unit: string | null;
  height_cm: number | null;
  height: string | null;
  age: number | null;
  gender: string | null;
  current_training_days: string | null;
  rest_days: number | null;
  // Read fresh on every focus so a just-onboarded Pinnacle athlete is
  // recognised without relaunching the app.
  tier: string | null;
};

type ExternalWorkout = {
  id: string;
  workout_type: string;
  start_time: string;
  duration_minutes: number;
  calories: number | null;
  source: string;
  distance_km: number | null;
  avg_hr: number | null;
  pace_per_km: number | null;
  effort_zone: string | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayLabel() {
  return new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatPace(pacePerKm: number, preferredUnits: string | null): string {
  const pace = preferredUnits === 'imperial' ? pacePerKm * 1.60934 : pacePerKm;
  const mins  = Math.floor(pace / 60);
  const secs  = Math.round(pace % 60).toString().padStart(2, '0');
  return `${mins}:${secs}/${preferredUnits === 'imperial' ? 'mi' : 'km'}`;
}

function formatDistance(distKm: number, preferredUnits: string | null): string {
  if (preferredUnits === 'imperial') return `${(distKm * 0.621371).toFixed(2)} mi`;
  return `${distKm.toFixed(2)} km`;
}

function buildCoachingMessage(
  goal: string | null,
  isRestDay: boolean,
  effortZone: string | null,
): string {
  const easyEffort  = effortZone === 'z1' || effortZone === 'z2';
  const hardEffort  = effortZone === 'z3' || effortZone === 'z4' || effortZone === 'z5';

  if (goal === 'hyrox') {
    if (isRestDay && easyEffort)  return 'Active recovery on a rest day — low and slow is exactly right.';
    if (isRestDay && hardEffort)  return 'Hard effort on a rest day. Prioritize recovery tonight.';
    if (!isRestDay && easyEffort) return 'Nice aerobic work to complement your session. Base-building pays off.';
    if (!isRestDay && hardEffort) return 'Strong extra effort. Stack your fuel and sleep well tonight.';
  }
  if (goal === 'gf' || goal === 'general_fitness') {
    if (isRestDay && easyEffort)  return 'Easy movement on a rest day — perfect active recovery.';
    if (isRestDay && hardEffort)  return 'Threshold work on a rest day. Ease off intensity tomorrow.';
    if (!isRestDay && easyEffort) return 'Good aerobic work. Build that base for event day.';
    if (!isRestDay && hardEffort) return 'Strong tempo run — quality effort. Rest up tonight.';
  }
  return 'Nice extra effort — make sure you recover well before your next session.';
}

function buildWorkoutSummary(day: ProgramDay): string {
  const sessions = day.sessions ?? [];
  const lifts: string[] = [];
  for (const session of sessions) {
    for (const block of session.blocks ?? []) {
      const bn = block.block_name.toLowerCase();
      if (bn.includes('warm') || bn.includes('cool')) continue;
      for (const ex of block.exercises ?? []) {
        lifts.push(ex.name);
      }
    }
  }
  if (lifts.length > 0) return lifts.slice(0, 4).join(' • ');
  const desc = sessions[0]?.description ?? '';
  if (desc) return desc.length > 70 ? desc.slice(0, 67) + '...' : desc;
  return sessions.map(s => s.name).filter(Boolean).join(' + ');
}

// ─── Streak helpers ───────────────────────────────────────────────────────────

function parseGoalTimeToMinutes(goalTime: string | null | undefined): number | null {
  if (!goalTime) return null;
  const parts = goalTime.split(':');
  if (parts.length >= 2) {
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    if (!isNaN(h) && !isNaN(m)) return h * 60 + m;
  }
  return null;
}

function isEliteHyroxProfile(goal: string | null, goalTime: string | null): boolean {
  if (goal !== 'hyrox') return false;
  const mins = parseGoalTimeToMinutes(goalTime);
  return mins !== null && mins <= 65;
}

function getDayNameLong(date: Date): string {
  return date.toLocaleDateString('en-US', { weekday: 'long' });
}

function calculateStreakValue(
  sessionDates: Set<string>,
  externalDates: Set<string>,
  restDayNames: Set<string>,
  isElite: boolean,
): number {
  let streak = 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i <= 365; i++) {
    const d       = new Date(today.getTime() - i * 86_400_000);
    const dateStr = d.toLocaleDateString('en-CA');
    const dayName = getDayNameLong(d);
    if (restDayNames.has(dayName)) { streak++; continue; }
    const hasSession  = sessionDates.has(dateStr);
    const countable   = isElite ? hasSession : (hasSession || externalDates.has(dateStr));
    if (countable)  { streak++; continue; }
    if (i === 0)    { continue; }
    break;
  }
  return streak;
}

function scoreStatusText(score: number): string {
  if (score >= 70) return 'Peak Zone';
  if (score >= 41) return 'Build Zone';
  return 'Rest Zone';
}

// ─── Tab cache prefetch ───────────────────────────────────────────────────────

async function prefetchTabCaches(uid: string, programs: Program[], profileData: any) {
  try {
    const programLogsRes = await supabase
      .from('session_logs')
      .select('week_number, day_name, log_field, session_name, session_time, id, peak_hr, avg_hr, hr_recovery_1min, hr_recovery_2min, zone_minutes, hr_screenshot_url, hr_curve_screenshot_url')
      .eq('user_id', uid)
      .not('day_name', 'is', null);
    const profileSubset = profileData ? {
      goal:                  profileData.goal ?? null,
      age:                   profileData.age ?? null,
      preferred_units:       profileData.preferred_units ?? null,
      current_training_days: profileData.current_training_days ?? null,
      rest_days:             profileData.rest_days ?? null,
    } : null;
    await AsyncStorage.setItem('program_cache', JSON.stringify({
      timestamp:   Date.now(),
      programs,
      sessionLogs: programLogsRes.data ?? [],
      profile:     profileSubset,
    }));
  } catch {}

  try {
    const [logsRes, extRes, checkinsRes, histProfRes] = await Promise.all([
      supabase.from('session_logs').select('*').eq('user_id', uid)
        .order('completed_at', { ascending: false }).limit(200),
      supabase.from('external_workouts').select('*').eq('user_id', uid)
        .order('start_time', { ascending: false }).limit(100),
      // Newest 30, reversed to ascending before caching. Must stay in sync with
      // the identical query in history.tsx — History reads this cache back, so
      // a mismatch would feed it stale/oldest rows.
      supabase.from('checkins').select('*').eq('user_id', uid)
        .order('created_at', { ascending: false }).limit(30),
      supabase.from('profiles').select('fitness_goal, weight_unit, preferred_units')
        .eq('id', uid).maybeSingle(),
    ]);
    await AsyncStorage.setItem('history_cache', JSON.stringify({
      timestamp:        Date.now(),
      logs:             logsRes.data ?? [],
      externalWorkouts: extRes.data ?? [],
      checkins:         [...(checkinsRes.data ?? [])].reverse(),
      profile:          histProfRes.data ?? null,
    }));
  } catch {}
}

// ─── Daily health cache ───────────────────────────────────────────────────────

async function saveHealthCache(uid: string, rd: WearableHealthData, date: string): Promise<void> {
  // Writes go through the upsert_health_reading RPC rather than a direct upsert:
  // it arbitrates per metric by source priority inside a single atomic statement,
  // so a lower-priority reading can never overwrite a higher-priority one and the
  // mobile sync can never race the Whoop cron.
  //
  // Sources arrive already gated and tagged by lib/healthKit.ts — 'Apple Watch'
  // or, for steps, 'iPhone'. Third-party samples were dropped at read time, so
  // nothing here can carry a foreign source name.
  const hrv       = rd.hrv?.value            ?? null;
  const restingHr = rd.restingHR?.value      ?? null;
  const sleep     = rd.sleepHours?.value     ?? null;
  const steps     = rd.steps?.value          ?? null;
  const activeCal = rd.activeCalories?.value ?? null;
  const totalCal  = rd.totalCalories?.value  ?? null;

  // Nothing to report — return without calling the RPC. Its first statement is an
  // unconditional INSERT ... ON CONFLICT DO NOTHING, so an all-null call would
  // still create an empty row for the day.
  if (hrv == null && restingHr == null && sleep == null &&
      steps == null && activeCal == null && totalCal == null) {
    return;
  }

  try {
    const { error } = await supabase.rpc('upsert_health_reading', {
      p_user_id:                uid,
      p_date:                   date,
      p_hrv:                    hrv,
      p_hrv_source:             hrv       != null ? (rd.hrv?.source            ?? null) : null,
      p_resting_hr:             restingHr,
      p_resting_hr_source:      restingHr != null ? (rd.restingHR?.source      ?? null) : null,
      p_sleep_hours:            sleep,
      p_sleep_source:           sleep     != null ? (rd.sleepHours?.source     ?? null) : null,
      p_steps:                  steps,
      p_steps_source:           steps     != null ? (rd.steps?.source          ?? null) : null,
      p_active_calories:        activeCal,
      p_active_calories_source: activeCal != null ? (rd.activeCalories?.source ?? null) : null,
      p_total_calories:         totalCal,
    });
    if (error) console.log('[health] upsert_health_reading error:', error.message);
  } catch (e) {
    console.log('[health] upsert_health_reading threw:', e);
  }
}

function cacheToReadiness(row: Record<string, any>): WearableHealthData {
  const r = (val: any, src: any) =>
    val != null ? { value: val as number, source: (src as string) ?? 'Cached' } : null;
  return {
    hrv:            r(row.hrv, row.hrv_source),
    restingHR:      r(row.resting_hr, row.resting_hr_source),
    sleepHours:     r(row.sleep_hours, row.sleep_source),
    steps:          r(row.steps, row.steps_source),
    activeCalories: r(row.active_calories, row.active_calories_source),
    basalCalories:  null,
    totalCalories:  r(row.total_calories, row.total_calories_source),
  };
}

// ─── Shimmer skeleton ─────────────────────────────────────────────────────────

function ShimmerBox({ width = 64, height = 26 }: { width?: number; height?: number }) {
  const opacity = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.65, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3,  duration: 700, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);
  return (
    <Animated.View style={{ width, height, backgroundColor: Colors.nested, borderRadius: 6, opacity }} />
  );
}

function PulsingRing() {
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.08, duration: 1200, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1,    duration: 1200, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [scale]);
  return (
    <Animated.View style={{
      width: 80, height: 80, borderRadius: 40, borderWidth: 2, borderColor: 'rgba(232,255,71,0.15)',
      position: 'absolute', alignSelf: 'center', backgroundColor: 'transparent',
      transform: [{ scale }],
    }} />
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function HomeScreen() {
  const navigation = useNavigation<CompositeNavigationProp<
    BottomTabNavigationProp<TabParamList>,
    NativeStackNavigationProp<MainStackParamList>
  >>();

  // Pinnacle status. isElite hard-blocks the week-2 generator below; a coach
  // owns these programs and nothing on this screen may author one.
  const { isElite } = React.useContext(ProgramStatusContext);
  const isEliteRef = useRef(isElite);
  isEliteRef.current = isElite;

  const [userId, setUserId]               = useState('');
  const [program, setProgram]             = useState<Program | null>(null);
  const [todayDay, setTodayDay]           = useState<ProgramDay | null>(null);
  const [sessionCount, setSessionCount]   = useState(0);
  const [streak, setStreak]               = useState(0);
  const [loading, setLoading]             = useState(true);
  // `loading` flips false as soon as the AsyncStorage cache is applied, which
  // can be an empty payload. `resolved` only flips once the server read has
  // finished, so an empty-state message never renders over unfetched data.
  const [resolved, setResolved]           = useState(false);
  const [milestone, setMilestone]         = useState<(typeof MILESTONES)[number] | null>(null);
  const [generatingWeek2, setGeneratingWeek2] = useState(false);
  const [week2Ready, setWeek2Ready]           = useState(false);
  const [week2Exists, setWeek2Exists]         = useState(false);
  const week2TriggeredRef = useRef(false);
  const mounted           = useRef(true);
  const loadIdRef         = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const [healthConnected, setHealthConnected] = useState(false);
  const [healthData, setHealthData]           = useState<HealthData | null>(null);
  const [readinessData, setReadinessData]     = useState<WearableHealthData | null>(null);
  const [peakScore, setPeakScore]             = useState<PeakScoreResult | null>(null);
  const [tdeeBase, setTdeeBase]               = useState<number | null>(null);
  const [bmr, setBmr]                         = useState<number | null>(null);
  const [fetchingFresh, setFetchingFresh]     = useState(false);
  const [externalWorkouts, setExternalWorkouts] = useState<ExternalWorkout[]>([]);
  const [profileGoal, setProfileGoal]         = useState<string | null>(null);
  const [preferredUnits, setPreferredUnits]   = useState<string | null>(null);
  const [showChestStrapTip, setShowChestStrapTip] = useState(false);
  const [storedProfile, setStoredProfile]     = useState<HomeProfile | null>(null);

  // Declared after storedProfile so the lookup can key off the freshly-read
  // tier rather than a flag captured at auth time.
  const { name: coachName, resolved: coachResolved } =
    useCoachName(storedProfile?.tier === 'elite' || isElite);
  const [pendingCandidates, setPendingCandidates] = useState<CandidateRow[]>([]);
  const [refreshing, setRefreshing]               = useState(false);
  const [completedTodayKeys, setCompletedTodayKeys] = useState<Set<string>>(new Set());
  const [scoreModalVisible, setScoreModalVisible] = useState(false);
  const [cacheStale, setCacheStale]               = useState(false);
  const [countupFraction, setCountupFraction]     = useState(1);

  // ── Count-up animation (once per calendar day) ──────────────────────────────

  async function runCountupIfNeeded() {
    const todayStr = new Date().toLocaleDateString('en-CA');
    const last = await AsyncStorage.getItem('countup_date');
    if (last === todayStr) return;
    await AsyncStorage.setItem('countup_date', todayStr);
    const startTime = Date.now();
    const duration = 600;
    function tick() {
      const elapsed = Date.now() - startTime;
      const f = Math.min(1, elapsed / duration);
      setCountupFraction(f);
      if (f < 1) requestAnimationFrame(tick);
    }
    setCountupFraction(0);
    requestAnimationFrame(tick);
  }

  // ── Week 2 generation ────────────────────────────────────────────────────────

  async function checkAndTriggerWeek2(uid: string, prog: Program) {
    // Hard stop for Pinnacle athletes: their coach writes every week by hand,
    // so this screen must never author one over the top. Guarded at the call
    // site too — this is the inner backstop.
    if (isEliteRef.current) return;
    const allTrialSessions = (prog.program_data?.days ?? [])
      .flatMap(d => d.sessions ?? [])
      .filter(s => s.log_result === true);
    if (allTrialSessions.length === 0) return;

    const { count } = await supabase
      .from('session_logs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', uid)
      .eq('week_number', 1)
      .not('log_value', 'is', null);

    if ((count ?? 0) < allTrialSessions.length) return;

    week2TriggeredRef.current = true;
    setGeneratingWeek2(true);
    try {
      const res = await fetch('https://peak65.vercel.app/api/generate-week2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: uid }),
      });
      if (res.ok) { setWeek2Exists(true); setWeek2Ready(true); }
    } catch (e) {
      console.log('[week2] generation error:', e);
    }
    setGeneratingWeek2(false);
  }

  // ── Acknowledge external workout ─────────────────────────────────────────────

  async function acknowledgeWorkout(id: string) {
    await supabase.from('external_workouts').update({ acknowledged: true }).eq('id', id);
    setExternalWorkouts(prev => prev.filter(w => w.id !== id));
  }

  // ── Load data ────────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    const myId = ++loadIdRef.current;

    // Apply cached home data immediately so screen renders without a spinner
    let cacheApplied = false;
    try {
      const raw = await AsyncStorage.getItem('home_cache');
      if (raw && mounted.current && myId === loadIdRef.current) {
        const c = JSON.parse(raw);
        const ageMs = Date.now() - (c.timestamp ?? 0);
        if (ageMs < 4 * 60 * 60 * 1000) {
          const prog = c.program as Program | null;
          setProgram(prog);
          if (prog?.program_data?.days) {
            const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
            const matched = prog.program_data.days.find((d: any) => d.day === todayName);
            setTodayDay(matched ?? null);
          } else {
            setTodayDay(null);
          }
          setStreak(c.streak ?? 0);
          setSessionCount(c.sessionCount ?? 0);
          // Per-session completion (completedTodayKeys) is intentionally NOT seeded from
          // cache — the fresh session_logs query below populates it. Cache skips this state.
          setWeek2Exists(c.week2Exists ?? false);
          setLoading(false);
          cacheApplied = true;
        }
        setCacheStale(ageMs > 4 * 60 * 60 * 1000);
      }
    } catch {}
    if (!cacheApplied) setLoading(true);

    const { data: { session } } = await supabase.auth.getSession();
    if (!mounted.current || myId !== loadIdRef.current) return;
    if (!session?.user) { setLoading(false); setResolved(true); return; }
    const uid = session.user.id;
    setUserId(uid);

    const todayStr = new Date().toLocaleDateString('en-US', { weekday: 'long' });

    const [progsRes, logsRes, profileRes, extStreakRes, cacheRes] = await Promise.all([
      supabase.from('programs').select('*').eq('user_id', uid)
        .not('is_draft', 'is', true)
        .order('week_number', { ascending: true }),
      supabase.from('session_logs').select('completed_at, completed, session_name, session_time')
        .eq('user_id', uid).eq('completed', true).order('completed_at', { ascending: false }),
      supabase.from('profiles')
        .select('wearable_connected, wearable_type, apple_health_connected, goal, goal_time, age, gender, height_cm, weight_kg, preferred_units, current_training_days, rest_days, body_weight, weight_unit, height, weight, units, chest_strap_tip_shown, coached_upsell_dismissed, whoop_connected, garmin_connected, coros_connected, manual_hrv, manual_hrv_date, program_start_date, tier')
        .eq('id', uid)
        .maybeSingle(),
      supabase.from('external_workouts')
        .select('start_time')
        .eq('user_id', uid)
        .gte('start_time', new Date(Date.now() - 60 * 86_400_000).toISOString()),
      supabase.from('daily_health_readings')
        .select('*')
        .eq('user_id', uid)
        .order('reading_date', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (!mounted.current || myId !== loadIdRef.current) return;

    const progs = (progsRes.data ?? []) as Program[];

    let activeProg: Program | null = null;
    for (const p of progs) {
      const start = new Date(p.week_start_date + 'T00:00:00');
      const end   = new Date(start.getTime() + 7 * 86_400_000);
      if (new Date() >= start && new Date() < end) { activeProg = p; break; }
    }
    if (!activeProg && progs.length > 0) activeProg = progs[progs.length - 1];

    const prog = activeProg;
    setProgram(prog);

    if (prog?.program_data?.days) {
      const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
      const matched = prog.program_data.days.find(d => d.day === todayName);
      setTodayDay(matched ?? null);
    }

    setWeek2Exists(progs.some(p => p.week_number === 2));

    const logs = logsRes.data ?? [];
    setSessionCount(logs.length);

    // Build the set of per-session completion keys for today (`${session_name}|${session_time}`)
    // so each AM/PM block can resolve its own completion. Uses the same local-date logic as before.
    const todayDateStr = new Date().toLocaleDateString('en-CA');
    const completedKeys = new Set<string>();
    for (const l of logs) {
      if (
        l.completed_at &&
        new Date(l.completed_at).toLocaleDateString('en-CA') === todayDateStr &&
        (l as any).completed === true
      ) {
        completedKeys.add(`${(l as any).session_name ?? ''}|${(l as any).session_time ?? ''}`);
      }
    }
    setCompletedTodayKeys(completedKeys);

    const sessionDates  = new Set(logs.map(l => new Date(l.completed_at).toLocaleDateString('en-CA')));
    const externalDates = new Set(
      (extStreakRes.data ?? []).map(w => new Date(w.start_time).toLocaleDateString('en-CA')),
    );
    const restDayNames = new Set(
      (prog?.program_data?.days ?? [])
        .filter(d => d.type === 'rest' || (d.sessions ?? []).length === 0)
        .map(d => d.day),
    );

    const profileData = profileRes.data as HomeProfile | null;
    setStoredProfile(profileData);
    setProfileGoal(profileData?.goal ?? null);
    setPreferredUnits(profileData?.preferred_units ?? null);

    // ── [DIAG] Profile token dump ──────────────────────────────────────────────
    // ──────────────────────────────────────────────────────────────────────────

    const isElite = isEliteHyroxProfile(profileData?.goal ?? null, profileData?.goal_time ?? null);
    const newStreak = calculateStreakValue(sessionDates, externalDates, restDayNames, isElite);
    console.log('[streak] isEliteHyrox:', isElite, 'streak:', newStreak);
    setStreak(newStreak);
    // Opt-in only. This gates the sole client writer of daily_health_readings, so
    // it must read the deliberate flag — not the legacy pair, which could have
    // been set without consent by the old init-success path.
    const isHealthConnected = profileData?.apple_health_connected === true;
    const isWhoopConnected = profileData?.whoop_connected === true;

    console.log('[health] wearable state from profile:', {
      wearable_connected: profileData?.wearable_connected,
      wearable_type:      profileData?.wearable_type,
      whoop_connected:    profileData?.whoop_connected,
      garmin_connected:   profileData?.garmin_connected,
      coros_connected:    profileData?.coros_connected,
    });
    console.log('[health] gate check — isHealthConnected (Apple Health):', isHealthConnected, '| isWhoopConnected:', isWhoopConnected);

    setHealthConnected(isHealthConnected);

    setLoading(false);
    setResolved(true);
    setCacheStale(false);
    runCountupIfNeeded();

    // Persist home data to AsyncStorage for instant render on next open
    AsyncStorage.setItem('home_cache', JSON.stringify({
      timestamp:      Date.now(),
      program:        prog,
      streak:         newStreak,
      sessionCount:   logs.length,
      week2Exists:    progs.some(p => p.week_number === 2),
    })).catch(() => {});

    // Background prefetch data for Program and History tabs
    prefetchTabCaches(uid, progs, profileRes.data).catch(() => {});

    // Apply cached health data immediately so metrics display before the background fetch.
    const cacheRow = cacheRes.data as Record<string, any> | null;
    console.log('[cache] daily_health_readings query — error:', cacheRes.error?.message ?? null, '| row date:', cacheRow?.date ?? null);
    if (cacheRow && (isHealthConnected || isWhoopConnected)) {
      const cachedRd = cacheToReadiness(cacheRow);
      setReadinessData(cachedRd);
      setHealthData({
        steps:             cachedRd.steps?.value         ?? null,
        activeCalories:    cachedRd.activeCalories?.value ?? null,
        totalCalories:     cachedRd.totalCalories?.value  ?? null,
        restingHR:         cachedRd.restingHR?.value      ?? null,
        hrv:               cachedRd.hrv?.value            ?? null,
        sleepHours:        cachedRd.sleepHours?.value     ?? null,
        exerciseMinutes:   null,
        lastActiveCalSync: null,
      });
      console.log('[cache] applied — hrv:', cachedRd.hrv?.value, '| sleep:', cachedRd.sleepHours?.value, '| rhr:', cachedRd.restingHR?.value, '| steps:', cachedRd.steps?.value, '| active:', cachedRd.activeCalories?.value, '| total:', cachedRd.totalCalories?.value);
    } else {
      console.log('[cache] no cache row — will show shimmer until fresh data arrives');
    }
    // Show shimmer on metric cards while the on-device HealthKit fetch runs. Whoop-only
    // users have no on-device fetch (backend cron writes the row), so they display
    // straight from the cached read above — no shimmer needed.
    if (isHealthConnected) setFetchingFresh(true);

    detectCandidates(uid)
      .then(() => getPendingCandidates(uid))
      .then(candidates => { if (mounted.current && myId === loadIdRef.current) setPendingCandidates(candidates); })
      .catch(e => console.log('[home] candidates error:', e));

    if (isHealthConnected) {
      getTodayHealthData()
        .then(async (data) => {
          if (!mounted.current || myId !== loadIdRef.current) return;
          console.log('[health] getTodayHealthData result:', JSON.stringify(data));
          setHealthData(data);

          if (profileData) {
            const tdee = computeTDEEFromProfile(profileData);
            if (tdee.ok) {
              setTdeeBase(tdee.value);
              const tDays = profileData.current_training_days != null
                ? (parseInt(profileData.current_training_days, 10) || 4)
                : profileData.rest_days != null ? Math.max(0, 7 - profileData.rest_days) : 4;
              setBmr(Math.round(tdee.value / getActivityMultiplier(tDays)));
            }
          }

          const score = await calculatePeakScore(uid, {
            hrv: data.hrv,
            rhr: data.restingHR,
            sleepHours: data.sleepHours,
            activeCalories: data.activeCalories,
          });
          if (!mounted.current || myId !== loadIdRef.current) return;
          if (score) setPeakScore(score);

          try {
            const workouts = await fetchTodayWorkouts(uid);
            if (!mounted.current || myId !== loadIdRef.current) return;
            if (workouts.length > 0) {
              const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
              await supabase.from('external_workouts').upsert(
                workouts.map(w => ({
                  user_id: uid,
                  external_id: w.externalId,
                  workout_type: w.type,
                  start_time: w.startDate,
                  end_time: w.endDate,
                  duration_minutes: w.durationMinutes,
                  distance_km: w.distanceKm,
                  calories: w.calories,
                  source: w.source,
                  avg_hr: w.avgHr,
                  max_hr: w.maxHr,
                  pace_per_km: w.pacePerKm,
                  effort_zone: w.effortZone,
                })),
                { onConflict: 'user_id,external_id' },
              );
              if (!mounted.current || myId !== loadIdRef.current) return;
              const { data: unacked } = await supabase
                .from('external_workouts')
                .select('*')
                .eq('user_id', uid)
                .eq('acknowledged', false)
                .gte('start_time', todayStart.toISOString());
              setExternalWorkouts(unacked ?? []);

              if (profileData?.chest_strap_tip_shown !== true) {
                setShowChestStrapTip(true);
              }
            }
          } catch (e) {
            console.log('[home] workouts error:', e);
          }
        })
        .catch(e => console.log('[home] healthKit error:', e));

      fetchTodayHealthData()
        .then(async rd => {
          console.log('[whoop-debug] fetchTodayHealthData .then — myId:', myId, 'current:', loadIdRef.current, 'mounted:', mounted.current);
          if (!mounted.current || myId !== loadIdRef.current) {
            console.log('[whoop-debug] BAILED after fetchTodayHealthData — not setting readinessData');
            return;
          }
          console.log('[health] fetchTodayHealthData result:', JSON.stringify(rd));
          // Whoop data (if any) is written to daily_health_readings by the backend cron
          // and surfaced via the cached read above — no direct Whoop fetch on-device.
          console.log('[whoop-debug] calling setReadinessData (Apple Health path) — hrv:', rd.hrv?.value, '| sleep:', rd.sleepHours?.value, '| rhr:', rd.restingHR?.value, '| steps:', rd.steps?.value, '| active:', rd.activeCalories?.value, '| total:', rd.totalCalories?.value);
          setReadinessData(rd);
          setFetchingFresh(false);
          saveHealthCache(uid, rd, new Date().toLocaleDateString('en-CA')).catch(() => {});
          if (profileData) {
            const wearables = getConnectedWearables(profileData);
            const tdee = computeTDEEFromProfile(profileData);
            const base = tdee.ok ? tdee.value : null;
            const tDays = profileData.current_training_days != null
              ? (parseInt(profileData.current_training_days, 10) || 4)
              : profileData.rest_days != null ? Math.max(0, 7 - profileData.rest_days) : 4;
            const localBmr = base != null ? Math.round(base / getActivityMultiplier(tDays)) : null;
            const sources = resolveAllSources(wearables, rd, profileData, base, localBmr);
            console.log('[home] totalCal final:', sources.totalCal.value, '| source:', sources.totalCal.source);
          }
          const hrv   = rd.hrv?.value         ?? null;
          const sleep = rd.sleepHours?.value   ?? null;
          const rhr   = rd.restingHR?.value    ?? null;
          console.log('[home] readiness row final values:', { hrv, sleep, rhr });
        })
        .catch(e => { console.log('[home] readiness fetch error:', e); setFetchingFresh(false); });

    } else {
      // Whoop-only users (no Apple Health) display from the cached daily_health_readings
      // read above, which the backend cron keeps current — no on-device Whoop fetch.
      console.log('[health] Apple Health not connected — health metrics come from backend-written daily_health_readings');
    }

    if (!isEliteRef.current && prog?.week_number === 1 && !week2Exists && !week2TriggeredRef.current) {
      checkAndTriggerWeek2(uid, prog);
    }

    // ── Missed session check (once per day) ──────────────────────────────────
    const todayDateKey = new Date().toLocaleDateString('en-CA');
    const lastMissedCheck = await AsyncStorage.getItem('last_missed_check');
    if (lastMissedCheck !== todayDateKey && prog) {
      await AsyncStorage.setItem('last_missed_check', todayDateKey);
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayName = yesterday.toLocaleDateString('en-US', { weekday: 'long' });
      const yesterdayStr  = yesterday.toLocaleDateString('en-CA');
      const yesterdayDay  = prog.program_data?.days?.find(d => d.day === yesterdayName);
      const isYesterdayWorkout =
        yesterdayDay &&
        yesterdayDay.type !== 'rest' &&
        (yesterdayDay.sessions ?? []).length > 0;
      if (isYesterdayWorkout) {
        const { count: yesterdayCount } = await supabase
          .from('session_logs')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', uid)
          .gte('completed_at', `${yesterdayStr}T00:00:00`)
          .lt('completed_at', `${todayDateKey}T00:00:00`);
        if ((yesterdayCount ?? 0) === 0) {
          fetch('https://peak65.vercel.app/api/ai-message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: uid, triggerType: 'missed_session' }),
          }).catch(() => {});
        }
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  useFocusEffect(useCallback(() => {
    console.log('[health] auto-refresh triggered by: focus');
    loadData();
  }, [loadData]));

  useEffect(() => {
    console.log('[whoop-debug] readinessData changed —', readinessData == null ? 'NULL' : `hrv:${readinessData.hrv?.value ?? 'null'} sleep:${readinessData.sleepHours?.value ?? 'null'} rhr:${readinessData.restingHR?.value ?? 'null'} steps:${readinessData.steps?.value ?? 'null'} active:${readinessData.activeCalories?.value ?? 'null'} total:${readinessData.totalCalories?.value ?? 'null'}`);
  }, [readinessData]);

  useEffect(() => {
    console.log('[whoop-debug] fetchingFresh changed —', fetchingFresh);
  }, [fetchingFresh]);

  const loadDataRef      = useRef(loadData);
  const appStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { loadDataRef.current = loadData; }, [loadData]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', next => {
      if (next === 'active') {
        console.log('[health] auto-refresh triggered by: foreground');
        if (appStateTimerRef.current) clearTimeout(appStateTimerRef.current);
        appStateTimerRef.current = setTimeout(() => {
          appStateTimerRef.current = null;
          loadDataRef.current();
        }, 500);
      }
    });
    return () => {
      sub.remove();
      if (appStateTimerRef.current) clearTimeout(appStateTimerRef.current);
    };
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <ActivityIndicator color={Colors.accent} style={{ flex: 1 }} />
      </SafeAreaView>
    );
  }

  const sessions  = [...(todayDay?.sessions ?? [])].sort((a, b) => (a.time === 'PM' ? 1 : 0) - (b.time === 'PM' ? 1 : 0));
  const isRestDay = todayDay?.type !== 'race' && (todayDay?.type === 'rest' || sessions.length === 0);

  const dayIndex = program?.program_data?.days?.findIndex(d => d.day === todayDay?.day) ?? -1;
  const dayLabel = dayIndex >= 0 ? `Day ${dayIndex + 1}` : (todayDay?.day ?? '');
  const typeLabel = todayDay?.type
    ? todayDay.type.charAt(0).toUpperCase() + todayDay.type.slice(1)
    : '';
  const sessionTitle = sessions.length === 1
    ? sessions[0].name
    : sessions.map(s => s.name).filter(Boolean).join(' + ');
  const workoutSummary = todayDay ? buildWorkoutSummary(todayDay) : '';

  // Fresh tier from this screen's own focus-refreshed profile read, falling
  // back to the gate's flag so the banner is right on the very first frame.
  const isEliteAthlete = storedProfile?.tier === 'elite' || isElite;

  const hasWearable = healthConnected || storedProfile?.whoop_connected === true;

  const hasWearableData = hasWearable && !!readinessData;
  const hrvR   = hasWearableData ? selectHRVSource(readinessData!, storedProfile ?? {}) : null;
  const sleepR = hasWearableData ? selectSleepSource(readinessData!) : null;
  const rhrR   = hasWearableData ? selectRHRSource(readinessData!) : null;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>

      {/* Milestone modal */}
      <Modal transparent visible={!!milestone} animationType="fade">
        <View style={styles.milestoneOverlay}>
          <View style={styles.milestoneCard}>
            <Text style={styles.milestoneEmoji}>{milestone?.emoji}</Text>
            <Text style={styles.milestoneNum}>{sessionCount}</Text>
            <Text style={styles.milestoneMsg}>{milestone?.message}</Text>
            <Text style={styles.milestoneSub}>{milestone?.sub}</Text>
            <TouchableOpacity style={styles.primaryBtn} onPress={() => setMilestone(null)}>
              <Text style={styles.primaryBtnText}>KEEP GOING</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <View style={{ flex: 1 }}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />}
      >

        {/* Header */}
        <View style={styles.header}>
          <Logo width={150} />
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={styles.headerDate}>{todayLabel()}</Text>
            {cacheStale && <Text style={{ color: Colors.textSecondary, fontSize: 10, marginTop: 1 }}>Refreshing...</Text>}
          </View>
        </View>

        {/* Peak Score bottom sheet — gated by Flags.PEAK_SCORE_ENABLED */}
        {Flags.PEAK_SCORE_ENABLED && (
        <Modal
          visible={scoreModalVisible}
          animationType="slide"
          presentationStyle="pageSheet"
          transparent={false}
          onRequestClose={() => setScoreModalVisible(false)}
        >
          <View style={{ flex: 1, justifyContent: 'flex-end' }}>
            <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setScoreModalVisible(false)} />
            <View style={styles.scoreSheet}>
              <View style={styles.sheetHandle} />
              <View style={{ alignItems: 'center', paddingHorizontal: 24, paddingTop: 16 }}>
                {hasWearable && peakScore ? (
                  <>
                    <View style={{ alignItems: 'center', justifyContent: 'center' }}>
                      <View style={[styles.scoreGlow, { backgroundColor: scoreColor(peakScore.score) + '1F' }]} />
                      <Text style={[styles.sheetScoreNum, { color: scoreColor(peakScore.score) }]}>{peakScore.score}</Text>
                    </View>
                    <Text style={styles.sheetCoachLine} numberOfLines={2}>{peakScore.coachingLine}</Text>
                  </>
                ) : (
                  <>
                    <Text style={[styles.sheetScoreNum, { color: '#8a877f' }]}>—</Text>
                    <Text style={styles.sheetCoachLine}>No score available yet</Text>
                  </>
                )}
              </View>
              <View style={styles.sheetDivider} />
              {[
                {
                  key: 'hrv',
                  label: 'HRV',
                  icon: <Activity size={16} color="#8a877f" />,
                  displayVal: (hrvR && !hrvR.noWearable && hrvR.value != null) ? `${Math.round(hrvR.value as number)}ms` : null,
                  explanation: 'Higher is better. Shows how recovered your nervous system is.',
                },
                {
                  key: 'sleep',
                  label: 'Sleep',
                  icon: <Moon size={16} color="#8a877f" />,
                  displayVal: (sleepR && !sleepR.noWearable && sleepR.value != null) ? `${(sleepR.value as number).toFixed(1)}h` : null,
                  explanation: 'Hours of sleep last night. Below 7 affects recovery.',
                },
                {
                  key: 'rhr',
                  label: 'RHR',
                  icon: <Heart size={16} color="#8a877f" />,
                  displayVal: (rhrR && !rhrR.noWearable && rhrR.value != null) ? `${Math.round(rhrR.value as number)}bpm` : null,
                  explanation: 'Lower resting HR = better aerobic fitness and recovery.',
                },
              ].map(m => (
                <View key={m.key} style={styles.sheetMetricRow}>
                  <View style={styles.sheetMetricHeader}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      {m.icon}
                      <Text style={styles.sheetMetricLabel}>{m.label}</Text>
                    </View>
                    <Text style={styles.sheetMetricVal}>{m.displayVal ?? '—'}</Text>
                  </View>
                  {m.displayVal != null ? (
                    <Text style={styles.sheetMetricExplain}>{m.explanation}</Text>
                  ) : (
                    <TouchableOpacity onPress={() => { setScoreModalVisible(false); navigation.navigate('Profile'); }}>
                      <Text style={styles.sheetConnectWearable}>Connect wearable →</Text>
                    </TouchableOpacity>
                  )}
                </View>
              ))}
            </View>
          </View>
        </Modal>
        )}

        {/* Peak Score hero card — gated by Flags.PEAK_SCORE_ENABLED */}
        {Flags.PEAK_SCORE_ENABLED && (() => {
          const sc = hasWearable && peakScore ? peakScore.score : null;
          const borderColor = sc != null ? scoreColor(sc) + '66' : '#1a1a1a';
          return (
            <TouchableOpacity activeOpacity={0.8} onPress={() => setScoreModalVisible(true)} style={[styles.scoreCard, { borderColor }]}>
              {sc != null ? (
                <View style={{ alignItems: 'center' }}>
                  <View style={[styles.scoreGlow, { backgroundColor: scoreColor(sc) + '1F' }]} />
                  <Text style={[styles.scoreNum, { color: scoreColor(sc) }]}>{sc}</Text>
                  <Text style={styles.heroCoachLine} numberOfLines={2}>{peakScore!.coachingLine}</Text>
                </View>
              ) : (
                <View style={{ alignItems: 'center', paddingVertical: 8 }}>
                  <Text style={styles.scoreCardEmptyLabel}>PEAK SCORE</Text>
                  <View style={{ height: 80, justifyContent: 'center', alignItems: 'center' }}>
                    <PulsingRing />
                  </View>
                  <TouchableOpacity onPress={() => navigation.navigate('Profile')} style={{ marginTop: 12 }}>
                    <Text style={styles.scoreCardConnectText}>Connect a wearable to unlock</Text>
                  </TouchableOpacity>
                </View>
              )}
            </TouchableOpacity>
          );
        })()}

        {/* ── TODAY'S SESSION (hero) ─────────────────────────────────────────── */}
        <Text style={styles.sectionHeader}>TODAY</Text>

        {/* Source of truth: elite tier + zero programs, both read fresh on every
            focus. Deliberately NOT keyed on awaitingProgram or program_status —
            those are snapshots taken before setup finishes writing, so they can
            be stale and would wrongly hide the banner. `!program` keeps the
            banner clearing the moment the coach's program lands. */}
        {!todayDay && !program && isEliteAthlete ? (
          // Hold the card until the coach's name is known, so it never renders
          // "Your coach" and then swaps to the real name a moment later.
          coachResolved ? (
            <View style={styles.coachBuildingCard}>
              <Target color={Colors.accent} size={28} strokeWidth={1.5} />
              <Text style={styles.coachBuildingTitle}>You're all set.</Text>
              <Text style={styles.coachBuildingBody}>
                {coachName} is building your program personally.
              </Text>
              <View style={styles.coachBuildingDivider} />
              <Text style={styles.coachBuildingNudge}>
                In the meantime — connect your Whoop and send {coachName} a message.
              </Text>
            </View>
          ) : (
            <View style={styles.emptyBlock}>
              <ActivityIndicator color={Colors.accent} />
            </View>
          )
        ) : !todayDay && !program && !resolved ? (
          // Server read still in flight — say nothing rather than the wrong thing.
          <View style={styles.emptyBlock}>
            <ActivityIndicator color={Colors.accent} />
          </View>
        ) : !todayDay ? (
          <View style={styles.emptyBlock}>
            {program && program.week_start_date ? (() => {
              const firstSession = program.program_data?.days?.find((d: any) => d.type !== 'rest' && d.sessions?.length > 0);
              const firstName = firstSession?.sessions?.[0]?.name ?? 'your first session';
              const startDate = new Date((storedProfile?.program_start_date || program.week_start_date) + 'T00:00:00');
              const today = new Date();
              today.setHours(0,0,0,0);
              const daysUntil = Math.round((startDate.getTime() - today.getTime()) / 86_400_000);
              const when = daysUntil === 1 ? 'Tomorrow' : daysUntil === 0 ? 'Today' : `In ${daysUntil} days`;
              return (
                <View style={{ gap: 8 }}>
                  <Text style={[styles.emptyText, { color: '#e8ff47', fontSize: 16, fontWeight: '700' }]}>{when}: {firstName}</Text>
                  <Text style={styles.emptyText}>Your baseline starts there. Everything builds from that session.</Text>
                </View>
              );
            })() : (
              <Text style={styles.emptyText}>Your program is being built. Check back shortly.</Text>
            )}
          </View>
        ) : isRestDay ? (
          <View style={styles.restCard}>
            <Moon color={Colors.accent} size={28} strokeWidth={1.5} />
            <Text style={styles.restTitle}>REST DAY</Text>
            <Text style={styles.restSub}>Recovery is where adaptation happens. Rest well.</Text>
          </View>
        ) : (
          <View style={styles.todayWrap}>
            {/* Day label + type badge */}
            <View style={styles.todayDayRow}>
              <Text style={styles.workoutDayLabel}>{dayLabel}</Text>
              {typeLabel ? (
                <View style={[styles.typeBadge, {
                  backgroundColor: todayDay!.type === 'hard' || todayDay!.type === 'trial' ? 'rgba(232,255,71,0.15)' :
                                   todayDay!.type === 'easy' ? 'rgba(0,212,170,0.15)' :
                                   todayDay!.type === 'race' ? 'rgba(0,212,170,0.15)' :
                                   'rgba(138,135,127,0.15)',
                }]}>
                  <Text style={[styles.typeBadgeText, {
                    color: todayDay!.type === 'hard' || todayDay!.type === 'trial' ? '#e8ff47' :
                           todayDay!.type === 'easy' ? '#00d4aa' :
                           todayDay!.type === 'race' ? '#00d4aa' :
                           '#8a877f',
                  }]}>{typeLabel.toUpperCase()}</Text>
                </View>
              ) : null}
            </View>

            {/* One block per session (doubles day shows AM + PM stacked) */}
            {sessions.map((session, si) => (
              <View key={si} style={styles.sessionBlock}>
                {!!session.time && (
                  <Text style={styles.sessionTimeLabel}>{session.time.toUpperCase()}</Text>
                )}
                <Text style={styles.sessionName}>{session.name}</Text>
                {!!session.description && (
                  <Text style={styles.sessionDesc}>{session.description}</Text>
                )}

                {(session.blocks ?? []).map((block, bi) => (
                  <View key={bi} style={styles.blockSection}>
                    <Text style={styles.blockLabel}>{block.block_name}</Text>
                    {(() => {
                      const exercises = block.exercises ?? [];
                      // Volume string: only show the "N×" multiplier when sets > 1.
                      // Circuit members pass hideSets so they never show a multiplier
                      // (rounds are conveyed by the "N ROUNDS" header instead).
                      const volume = (ex: ExerciseItem, hideSets?: boolean): string => {
                        const parts: string[] = [];
                        const setsNum = ex.sets ? Number(ex.sets) : 0;
                        if (!hideSets && setsNum > 1 && ex.reps) parts.push(`${ex.sets}×${ex.reps}`);
                        else if (ex.reps && ex.reps !== '1')     parts.push(ex.reps);
                        if (ex.duration)                         parts.push(ex.duration);
                        else if (ex.distance)                    parts.push(ex.distance);
                        return parts.join(' · ');
                      };
                      const line = (ex: ExerciseItem, key: string, hideSets: boolean, indent: boolean) => {
                        const detail = volume(ex, hideSets);
                        return (
                          <View key={key} style={[styles.exerciseRow, indent ? { marginLeft: 10 } : null]}>
                            <Text style={styles.exerciseName} numberOfLines={2}>{ex.name}</Text>
                            {detail ? <Text style={styles.exerciseDetail}>{detail}</Text> : null}
                          </View>
                        );
                      };
                      // Inner walk: group a slice of exercises by emom_id / circuit_id,
                      // standalone otherwise. Used both at the top level and within a Part.
                      const renderExerciseSlice = (slice: ExerciseItem[], kp: string): React.ReactNode[] => {
                        const nodes: React.ReactNode[] = [];
                        let j = 0;
                        while (j < slice.length) {
                          const ex = slice[j];
                          if (ex.emom_id) {
                            const eId = ex.emom_id;
                            const members: ExerciseItem[] = [];
                            while (j < slice.length && slice[j].emom_id === eId) { members.push(slice[j]); j++; }
                            const label  = (members[0].emom_label ?? 'EMOM').toUpperCase();
                            const rounds = members[0].emom_rounds;
                            const header = `${label}${rounds ? ` · ${rounds} ROUNDS` : ''}`;
                            nodes.push(
                              <View key={`${kp}-emom-${j}`}>
                                <Text style={styles.circuitRoundsLabel}>{header}</Text>
                                {members.map((m, mi) => (
                                  <View key={`${kp}-em-${j}-${mi}`} style={styles.emomMemberRow}>
                                    {m.time_window ? <Text style={styles.emomWindow}>{m.time_window}</Text> : null}
                                    <View style={{ flex: 1 }}>{line(m, `${kp}-eml-${j}-${mi}`, true, false)}</View>
                                  </View>
                                ))}
                              </View>,
                            );
                          } else if (ex.amrap_id) {
                            const aId = ex.amrap_id;
                            const members: ExerciseItem[] = [];
                            while (j < slice.length && slice[j].amrap_id === aId) { members.push(slice[j]); j++; }
                            const label   = (members[0].amrap_label ?? 'AMRAP').toUpperCase();
                            const timeCap = members[0].amrap_time_cap;
                            const header  = `${label}${timeCap ? ` · ${timeCap} MIN` : ''}`;
                            nodes.push(
                              <View key={`${kp}-amrap-${j}`}>
                                <Text style={styles.circuitRoundsLabel}>{header}</Text>
                                {members.map((m, mi) => (
                                  <View key={`${kp}-am-${j}-${mi}`} style={styles.emomMemberRow}>
                                    {m.time_window ? <Text style={styles.emomWindow}>{m.time_window}</Text> : null}
                                    <View style={{ flex: 1 }}>{line(m, `${kp}-aml-${j}-${mi}`, true, false)}</View>
                                  </View>
                                ))}
                              </View>,
                            );
                          } else if (ex.circuit_id) {
                            const cId = ex.circuit_id;
                            const members: ExerciseItem[] = [];
                            while (j < slice.length && slice[j].circuit_id === cId) { members.push(slice[j]); j++; }
                            const rounds = members[0].circuit_rounds ?? 4;
                            nodes.push(
                              <View key={`${kp}-c-${j}`}>
                                <Text style={styles.circuitRoundsLabel}>{rounds} Rounds</Text>
                                {members.map((m, mi) => line(m, `${kp}-cm-${j}-${mi}`, true, true))}
                              </View>,
                            );
                          } else {
                            nodes.push(line(ex, `${kp}-e-${j}`, false, false));
                            j++;
                          }
                        }
                        return nodes;
                      };

                      // Outer walk: split into Parts (named block_id groups). Each Part
                      // renders its block_name header once, then its inner slice below it.
                      const out: React.ReactNode[] = [];
                      let i = 0;
                      while (i < exercises.length) {
                        const ex = exercises[i];
                        if (ex.block_id) {
                          const bId = ex.block_id;
                          const partName = ex.block_name;
                          const members: ExerciseItem[] = [];
                          while (i < exercises.length && exercises[i].block_id === bId) { members.push(exercises[i]); i++; }
                          out.push(
                            <View key={`part-${bi}-${i}`}>
                              {partName ? <Text style={styles.partLabel}>{partName}</Text> : null}
                              {renderExerciseSlice(members, `p-${bi}-${i}`)}
                            </View>,
                          );
                        } else {
                          // Run of non-Part exercises — keep circuit/emom grouping intact.
                          const members: ExerciseItem[] = [];
                          while (i < exercises.length && !exercises[i].block_id) { members.push(exercises[i]); i++; }
                          out.push(...renderExerciseSlice(members, `top-${bi}-${i}`));
                        }
                      }
                      return out;
                    })()}
                  </View>
                ))}

                {/* Log button (or completed state) — per-session via name|time key */}
                {program && (completedTodayKeys.has(`${session.name}|${session.time}`) ? (
                  <View style={[styles.viewWorkoutBtn, { backgroundColor: '#1a2a1a', marginTop: 12 }]}>
                    <Text style={[styles.viewWorkoutBtnText, { color: '#4aff78' }]}>SESSION COMPLETE ✓</Text>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={[styles.viewWorkoutBtn, { marginTop: 12 }]}
                    activeOpacity={0.85}
                    onPress={() => navigation.navigate('LogSession', {
                      sessionJson: JSON.stringify(session),
                      programId:   program.id,
                      weekNumber:  program.week_number,
                      dayName:     todayDay!.day,
                    })}
                  >
                    <Text style={styles.viewWorkoutBtnText}>LOG SESSION →</Text>
                  </TouchableOpacity>
                ))}
              </View>
            ))}
          </View>
        )}

        {/* Streak + Sessions row */}
        <View style={styles.row}>
          <View style={[styles.miniCard, { flex: 1 }]}>
            <View style={styles.streakRow}>
              <Flame color={Colors.accent} size={18} strokeWidth={1.5} />
              <Text style={styles.streakNum}>{Math.round(streak * countupFraction)}</Text>
            </View>
            <Text style={styles.miniCardLabel}>Day Streak</Text>
            {streak > 0 && <Text style={styles.miniCardSub}>Keep your plan. Keep your streak.</Text>}
          </View>
          <View style={[styles.miniCard, { flex: 1 }]}>
            <View style={styles.streakRow}>
              <Dumbbell color={Colors.accent} size={18} strokeWidth={1.5} />
              <Text style={styles.streakNum}>{Math.round(sessionCount * countupFraction)}</Text>
            </View>
            <Text style={styles.miniCardLabel}>Sessions</Text>
            {sessionCount > 0 && <Text style={styles.miniCardSub}>Each one compounds.</Text>}
          </View>
        </View>

        {/* Progress toward your goal */}
        {program && (
          <>
            <Text style={styles.sectionHeader}>PROGRESS TOWARD YOUR GOAL</Text>
            <View style={styles.progressCard}>
              <Text style={styles.progressWeek}>Week {program.week_number}</Text>
              {storedProfile?.goal_time ? (
                <Text style={styles.progressGoal}>Goal: {storedProfile.goal_time}</Text>
              ) : null}
            </View>
          </>
        )}

        {/* Stats row — Active | Total — gated by Flags.CALORIE_CARDS_ENABLED */}
        {Flags.CALORIE_CARDS_ENABLED && (
        <View style={styles.row}>
          {/* Active Calories */}
          <View style={[styles.statCard, { flex: 1 }]}>
            <Zap color={Colors.textSecondary} size={20} strokeWidth={1.5} />
            {fetchingFresh && !readinessData && hasWearable ? (
              <ShimmerBox width={64} height={26} />
            ) : (
              <Text style={styles.statVal}>
                {hasWearable && (readinessData?.activeCalories?.value ?? healthData?.activeCalories) != null
                  ? `${Math.round((readinessData?.activeCalories?.value ?? healthData?.activeCalories)! * countupFraction)}`
                  : '--'}
              </Text>
            )}
            <Text style={styles.statLabel}>Active Cal</Text>
            {!hasWearable && (
              <TouchableOpacity onPress={() => navigation.navigate('Profile')}>
                <Text style={styles.connectBtn}>Connect →</Text>
              </TouchableOpacity>
            )}
          </View>
          {/* Total calories — Whoop cycle total or BMR + active projection */}
          {(() => {
            if (fetchingFresh && !readinessData && hasWearable) {
              return (
                <View style={[styles.statCard, { flex: 1 }]}>
                  <Target color={Colors.textSecondary} size={20} strokeWidth={1.5} />
                  <ShimmerBox width={64} height={26} />
                  <Text style={styles.statLabel}>Total Cal</Text>
                </View>
              );
            }
            const whoopTotal = readinessData?.totalCalories?.source?.includes('Whoop')
              ? readinessData.totalCalories.value : null;
            if (whoopTotal != null) {
              const now = new Date();
              // Use cycle start time for accurate extrapolation (avoids midnight-offset error).
              // cycleStart is stored in readinessData via a custom field if available; fall back
              // to hours-since-midnight capped at a minimum of 1h to avoid division by near-zero.
              const cycleStartIso: string | null = (readinessData as any)?.cycleStart ?? null;
              const hoursIntoCycle = cycleStartIso
                ? Math.max(1, (now.getTime() - new Date(cycleStartIso).getTime()) / 3_600_000)
                : Math.max(1, now.getHours() + now.getMinutes() / 60);
              // Only project when at least 2h into the cycle and not near end-of-day.
              const projectedTotal = hoursIntoCycle > 2 && hoursIntoCycle < 22
                ? Math.round(whoopTotal * 24 / hoursIntoCycle)
                : null;
              console.log('[home] Total Cal display: Whoop cycle total:', whoopTotal, '| hoursIntoCycle:', hoursIntoCycle.toFixed(1), '| projected:', projectedTotal);
              return (
                <View style={[styles.statCard, { flex: 1 }]}>
                  <Target color={Colors.textSecondary} size={20} strokeWidth={1.5} />
                  <Text style={styles.statVal}>{Math.round((projectedTotal ?? whoopTotal)! * countupFraction)}</Text>
                  <Text style={styles.statLabel}>{projectedTotal != null ? 'Projected' : 'Total Cal'}</Text>
                  <Text style={styles.statSub}>{projectedTotal != null ? `${whoopTotal} so far` : 'Whoop'}</Text>
                </View>
              );
            }
            const activeSoFar = hasWearable
              ? (readinessData?.activeCalories?.value ?? healthData?.activeCalories ?? null)
              : null;
            const now          = new Date();
            const hoursElapsed = now.getHours() + now.getMinutes() / 60;
            // Use raw BMR as base to avoid double-counting NEAT already in tdeeBase
            const base         = bmr ?? tdeeBase;
            const basalSoFar   = base != null ? Math.round((base / 24) * hoursElapsed) : null;
            const currentBurn  = basalSoFar != null && activeSoFar != null
              ? basalSoFar + activeSoFar
              : basalSoFar ?? null;
            const projected    = base != null && activeSoFar != null ? base + activeSoFar : null;
            console.log('[home] Total Cal display: activeSoFar:', activeSoFar, '| bmr:', bmr, '| tdeeBase:', tdeeBase, '| projected:', projected);
            const syncTime     = healthData?.lastActiveCalSync
              ? new Date(healthData.lastActiveCalSync).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
              : null;
            if (!hasWearable || projected == null) {
              return (
                <View style={[styles.statCard, { flex: 1 }]}>
                  <Target color={Colors.textSecondary} size={20} strokeWidth={1.5} />
                  <Text style={styles.statVal}>--</Text>
                  <Text style={styles.statLabel}>Total Cal</Text>
                  {!hasWearable && (
                    <TouchableOpacity onPress={() => navigation.navigate('Profile')}>
                      <Text style={styles.connectBtn}>Connect →</Text>
                    </TouchableOpacity>
                  )}
                </View>
              );
            }
            return (
              <View style={[styles.statCard, { flex: 1 }]}>
                <Target color={Colors.textSecondary} size={20} strokeWidth={1.5} />
                <Text style={styles.statVal}>{Math.round(projected * countupFraction)}</Text>
                <Text style={styles.statLabel}>Projected</Text>
                {currentBurn != null && <Text style={styles.statSub}>{currentBurn} so far</Text>}
                {syncTime && <Text style={styles.statSync}>synced {syncTime}</Text>}
              </View>
            );
          })()}
        </View>
        )}


        {/* Workout confirmation cards */}
        {pendingCandidates.map(candidate => (
          <WorkoutConfirmationCard
            key={candidate.id}
            candidate={candidate}
            todaySessionNames={sessions.map(s => s.name)}
            onResolved={() => {
              getPendingCandidates(userId)
                .then(setPendingCandidates)
                .catch(() => {});
            }}
          />
        ))}

        {/* Extra workouts from wearable (off-program) */}
        {externalWorkouts.map(w => {
          const metaParts: string[] = [`${w.duration_minutes} min`];
          if (w.distance_km != null) metaParts.push(formatDistance(w.distance_km, preferredUnits));
          if (w.pace_per_km != null) metaParts.push(formatPace(w.pace_per_km, preferredUnits));
          if (w.calories != null)    metaParts.push(`${w.calories} kcal`);
          metaParts.push(w.source);
          return (
            <View key={w.id} style={styles.extraWorkoutCard}>
              <View style={styles.extraWorkoutHeader}>
                <Text style={styles.extraWorkoutBadge}>OFF-PROGRAM</Text>
                <Text style={styles.extraWorkoutType}>
                  {WORKOUT_TYPE_LABELS[w.workout_type] ?? w.workout_type.toUpperCase()}
                </Text>
              </View>
              <Text style={styles.extraWorkoutMeta}>{metaParts.join(' · ')}</Text>
              {w.avg_hr != null && (
                <Text style={styles.extraWorkoutHR}>
                  Avg HR: {w.avg_hr} bpm{w.effort_zone && w.effort_zone !== 'unknown' ? ` · ${w.effort_zone.toUpperCase()}` : ''}
                </Text>
              )}
              <Text style={styles.extraWorkoutCoach}>
                {buildCoachingMessage(profileGoal, isRestDay, w.effort_zone)}
              </Text>
              <TouchableOpacity
                style={styles.acknowledgeBtn}
                onPress={() => acknowledgeWorkout(w.id)}
              >
                <Text style={styles.acknowledgeBtnText}>ACKNOWLEDGE</Text>
              </TouchableOpacity>
            </View>
          );
        })}

        {/* Chest strap tip — shown once after first workout detected */}
        {showChestStrapTip && (
          <View style={styles.chestStrapCard}>
            <Text style={styles.chestStrapTitle}>More accurate HR data</Text>
            <Text style={styles.chestStrapBody}>
              Using a chest strap heart rate monitor during workouts gives you more precise HR zones — especially for Hyrox runs and SkiErg intervals.
            </Text>
            <TouchableOpacity
              style={styles.chestStrapBtn}
              onPress={async () => {
                setShowChestStrapTip(false);
                await supabase.from('profiles').update({ chest_strap_tip_shown: true }).eq('id', userId);
              }}
            >
              <Text style={styles.chestStrapBtnText}>GOT IT</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Week 2 generation banner */}
        {generatingWeek2 && (
          <View style={styles.week2Banner}>
            <ActivityIndicator size="small" color={Colors.accent} style={{ marginRight: 10 }} />
            <View>
              <Text style={styles.week2Title}>Building Week 2...</Text>
              <Text style={styles.week2Sub}>Your coach is reviewing your trial results.</Text>
            </View>
          </View>
        )}
        {week2Ready && !generatingWeek2 && (
          <View style={[styles.week2Banner, styles.week2BannerReady]}>
            <Feather name="calendar" color={Colors.green} size={22} style={{ marginRight: 10 }} />
            <View>
              <Text style={[styles.week2Title, { color: Colors.green }]}>Week 2 is ready.</Text>
              <Text style={styles.week2Sub}>Open the Program tab to view it.</Text>
            </View>
          </View>
        )}

      </ScrollView>
      <View style={{ height: 40, position: 'absolute', bottom: 0, left: 0, right: 0 }} pointerEvents="none">
        <LinearGradient colors={['transparent', '#111111']} style={{ flex: 1 }} />
      </View>
      </View>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8,
  },
  headerLogo: { color: Colors.accent, fontSize: 20, fontWeight: '800', letterSpacing: -0.5 },
  headerDate: { color: Colors.textSecondary, fontSize: 13 },

  // Peak Score hero card
  scoreCard: {
    margin: 16, backgroundColor: Colors.card, borderRadius: 16, padding: 24,
    alignItems: 'center', borderWidth: 0.5,
  },
  scoreNum: {
    fontFamily: Fonts.metricHeavy, fontSize: 88, lineHeight: 100,
  },
  scoreGlow: {
    position: 'absolute', width: 140, height: 140, borderRadius: 70,
  },
  heroCoachLine: {
    color: '#8a877f', fontSize: 13, fontStyle: 'italic', textAlign: 'center', marginTop: 4,
  },
  scoreCardEmptyLabel: {
    color: '#8a877f', fontSize: 11, fontWeight: '600', letterSpacing: 2,
    textTransform: 'uppercase', textAlign: 'center', marginBottom: 16,
  },
  scoreCardConnectText: { color: '#e8ff47', fontSize: 12 },

  // Peak Score bottom sheet
  scoreSheet: {
    backgroundColor: '#111111',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingBottom: 40,
  },
  sheetHandle: {
    width: 40, height: 4, backgroundColor: '#333', borderRadius: 2,
    alignSelf: 'center', marginTop: 12, marginBottom: 20,
  },
  sheetScoreNum: {
    fontFamily: Fonts.metricHeavy, fontSize: 72,
  },
  sheetCoachLine: {
    color: '#8a877f', fontSize: 14, fontStyle: 'italic', textAlign: 'center',
    marginTop: 8, marginBottom: 24,
  },
  sheetDivider: {
    height: 1, backgroundColor: '#1a1a1a', marginBottom: 24, marginHorizontal: 24,
  },
  sheetMetricRow: {
    paddingHorizontal: 24, marginBottom: 20,
  },
  sheetMetricHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  sheetMetricLabel: {
    color: '#8a877f', fontSize: 12, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase',
  },
  sheetMetricVal: {
    fontFamily: Fonts.metricHeavy, fontSize: 18, color: 'white',
  },
  sheetMetricExplain: {
    color: '#8a877f', fontSize: 12, marginTop: 4,
  },
  sheetConnectWearable: {
    color: '#e8ff47', fontSize: 12, marginTop: 4,
  },

  // Mini + stat cards
  row: { flexDirection: 'row', paddingHorizontal: 16, gap: 10, marginBottom: 10 },
  miniCard: { backgroundColor: Colors.card, borderRadius: 14, padding: 16, alignItems: 'center', justifyContent: 'center' },
  streakRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  streakNum: {
    fontFamily: Fonts.metric, fontSize: 32, color: Colors.textPrimary,
  },
  miniCardLabel: { color: Colors.textSecondary, fontSize: 12, fontWeight: '600', marginBottom: 2 },
  miniCardSub: { color: Colors.textSecondary, fontSize: 11 },
  statCard: {
    backgroundColor: Colors.card, borderRadius: 14, padding: 12, alignItems: 'center', justifyContent: 'center', gap: 4,
  },
  statVal: {
    fontFamily: Fonts.metric, color: Colors.textPrimary, fontSize: 26,
  },
  statLabel: { color: Colors.textSecondary, fontSize: 11, fontWeight: '600' },
  statSub:  { color: Colors.textSecondary, fontSize: 10 },
  statSync: { color: Colors.textSecondary, fontSize: 9, marginTop: 1 },
  connectBtn: { color: '#e8ff47', fontSize: 12, fontWeight: '600' },

  // Today section header
  todayHeader: {
    color: Colors.accent, fontSize: 11, fontWeight: '700', letterSpacing: 1.5,
    textTransform: 'uppercase', paddingHorizontal: 20, marginTop: 8, marginBottom: 12,
  },
  emptyBlock: { paddingHorizontal: 20, paddingVertical: 24 },
  emptyText: { color: Colors.textSecondary, fontSize: 15, textAlign: 'center' },

  // Section header (session-first layout)
  sectionHeader: {
    color: Colors.accent, fontSize: 11, fontWeight: '700', letterSpacing: 1.5,
    textTransform: 'uppercase', paddingHorizontal: 20, marginTop: 12, marginBottom: 12,
  },

  // Today's session — hero
  todayWrap: { gap: 12, marginBottom: 12 },
  todayDayRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20,
  },
  sessionBlock: {
    marginHorizontal: 16, backgroundColor: '#111111', borderRadius: 16,
    padding: 20, borderLeftWidth: 3, borderLeftColor: Colors.accent,
  },
  sessionTimeLabel: {
    color: '#e8ff47', fontSize: 12, fontWeight: '800', letterSpacing: 1.5, marginBottom: 4,
  },
  sessionName: {
    fontFamily: Fonts.metricHeavy, fontSize: 26, color: '#f0ede8', marginBottom: 4,
  },
  sessionDesc: {
    color: '#8a877f', fontSize: 13, lineHeight: 19, marginBottom: 8,
  },
  blockSection: { marginTop: 14 },
  blockLabel: {
    color: '#8a877f', fontSize: 10, fontWeight: '700', letterSpacing: 1.5,
    textTransform: 'uppercase', marginBottom: 8,
  },
  circuitRoundsLabel: {
    color: '#8a877f', fontSize: 10, fontWeight: '700', letterSpacing: 1.5,
    textTransform: 'uppercase', marginTop: 4, marginBottom: 6,
  },
  partLabel: {
    color: '#e8ff47', fontSize: 11, fontWeight: '700', letterSpacing: 1.5,
    textTransform: 'uppercase', marginTop: 10, marginBottom: 6,
  },
  emomMemberRow: {
    flexDirection: 'row', alignItems: 'flex-start',
  },
  emomWindow: {
    color: '#e8ff47', fontSize: 12, fontWeight: '700', marginRight: 8, minWidth: 30,
  },
  exerciseRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    gap: 12, marginBottom: 8,
  },
  exerciseName: { color: '#f0ede8', fontSize: 14, fontWeight: '600', flex: 1 },
  exerciseDetail: { color: '#8a877f', fontSize: 13, fontWeight: '600' },

  // Rest day
  restCard: {
    marginHorizontal: 16, backgroundColor: '#111111', borderRadius: 16,
    paddingVertical: 24, paddingHorizontal: 20, alignItems: 'center', gap: 10,
    marginBottom: 12,
  },

  // Pinnacle athlete waiting on their coach's program
  coachBuildingCard: {
    marginHorizontal: 16, backgroundColor: '#111111', borderRadius: 16,
    paddingVertical: 26, paddingHorizontal: 22, alignItems: 'center', gap: 12,
    marginBottom: 12, borderLeftWidth: 3, borderLeftColor: Colors.accent,
  },
  coachBuildingTitle: {
    fontFamily: Fonts.metricHeavy, fontSize: 30, color: '#f0ede8', letterSpacing: 1,
  },
  coachBuildingBody: {
    color: '#f0ede8', fontSize: 15, textAlign: 'center', lineHeight: 22,
  },
  coachBuildingDivider: {
    height: 1, alignSelf: 'stretch', backgroundColor: Colors.border, marginVertical: 2,
  },
  coachBuildingNudge: {
    color: '#8a877f', fontSize: 14, textAlign: 'center', lineHeight: 20,
  },
  restTitle: {
    fontFamily: Fonts.metricHeavy, fontSize: 30, color: '#f0ede8', letterSpacing: 1,
  },
  restSub: { color: '#8a877f', fontSize: 14, textAlign: 'center', lineHeight: 20 },

  // Progress toward goal
  progressCard: {
    marginHorizontal: 16, backgroundColor: '#111111', borderRadius: 16,
    padding: 20, gap: 6,
  },
  progressWeek: { fontFamily: Fonts.metricHeavy, fontSize: 22, color: '#f0ede8' },
  progressGoal: { color: '#e8ff47', fontSize: 14, fontWeight: '700' },

  // Compact workout card
  workoutCard: {
    marginHorizontal: 16, backgroundColor: Colors.card, borderRadius: 16,
    padding: 20, paddingBottom: 24,
    borderLeftWidth: 3, borderLeftColor: Colors.accent, gap: 12,
  },
  workoutCardTop: { gap: 4 },
  workoutDayLabel: {
    color: Colors.textSecondary, fontSize: 11, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 1,
  },
  workoutSessionTitle: { fontFamily: Fonts.metricHeavy, fontSize: 26, color: '#f0ede8' },
  workoutSummary: { color: Colors.textSecondary, fontSize: 13, lineHeight: 18 },
  typeBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  typeBadgeText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  viewWorkoutBtn: {
    backgroundColor: Colors.accent, borderRadius: 10, paddingVertical: 13,
    alignItems: 'center', marginTop: 4,
  },
  viewWorkoutBtnText: { color: Colors.background, fontSize: 14, fontWeight: '800', letterSpacing: 0.5 },

  // Off-program / extra workout card
  extraWorkoutCard: {
    marginHorizontal: 16, marginTop: 10, backgroundColor: Colors.card,
    borderRadius: 16, padding: 20, borderLeftWidth: 3, borderLeftColor: '#ff9944', gap: 8,
  },
  extraWorkoutHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  extraWorkoutBadge: {
    color: '#ff9944', fontSize: 10, fontWeight: '700', letterSpacing: 1,
  },
  extraWorkoutType: { color: Colors.textPrimary, fontSize: 16, fontWeight: '800' },
  extraWorkoutMeta:  { color: Colors.textSecondary, fontSize: 13 },
  extraWorkoutHR:    { color: Colors.textSecondary, fontSize: 12, marginTop: 2 },
  extraWorkoutCoach: { color: Colors.textPrimary, fontSize: 13, lineHeight: 18 },
  acknowledgeBtn: {
    backgroundColor: Colors.nested, borderRadius: 10, paddingVertical: 11,
    alignItems: 'center', marginTop: 4, borderWidth: 1, borderColor: Colors.border,
  },
  acknowledgeBtnText: { color: Colors.textSecondary, fontSize: 13, fontWeight: '700', letterSpacing: 0.5 },

  // Primary button (milestone modal)
  primaryBtn: {
    backgroundColor: Colors.accent, borderRadius: 12, paddingVertical: 16,
    alignItems: 'center', marginHorizontal: 16, marginBottom: 10,
  },
  primaryBtnText: { color: Colors.background, fontSize: 16, fontWeight: '700' },

  // Milestone modal
  milestoneOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center', justifyContent: 'center', padding: 32,
  },
  milestoneCard: { alignItems: 'center', gap: 12, width: '100%' },
  milestoneEmoji: { fontSize: 64 },
  milestoneNum: { color: Colors.accent, fontFamily: Fonts.metricHeavy, fontSize: 72 },
  milestoneMsg: { color: Colors.textPrimary, fontSize: 22, fontWeight: '700', textAlign: 'center' },
  milestoneSub: { color: Colors.textSecondary, fontSize: 15, textAlign: 'center', marginBottom: 16 },

  // Chest strap tip card
  chestStrapCard: {
    marginHorizontal: 16, marginTop: 10, backgroundColor: Colors.card,
    borderRadius: 16, padding: 18, gap: 10,
    borderLeftWidth: 3, borderLeftColor: '#4488ff',
  },
  chestStrapTitle: { color: Colors.textPrimary, fontSize: 14, fontWeight: '700' },
  chestStrapBody:  { color: Colors.textSecondary, fontSize: 13, lineHeight: 18 },
  chestStrapBtn: {
    backgroundColor: Colors.nested, borderRadius: 10, paddingVertical: 11,
    alignItems: 'center', borderWidth: 1, borderColor: Colors.border,
  },
  chestStrapBtnText: { color: Colors.textSecondary, fontSize: 13, fontWeight: '700', letterSpacing: 0.5 },

  // Week 2 banner
  week2Banner: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: 16, marginTop: 12, marginBottom: 4,
    backgroundColor: Colors.card, borderRadius: 14, padding: 16,
    borderLeftWidth: 3, borderLeftColor: Colors.accent,
  },
  week2BannerReady: { borderLeftColor: Colors.green },
  week2Title: { color: Colors.accent, fontSize: 14, fontWeight: '700', marginBottom: 2 },
  week2Sub:   { color: Colors.textSecondary, fontSize: 12 },
});
