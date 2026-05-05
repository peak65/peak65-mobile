import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import {
  View, Text, ScrollView, TouchableOpacity, RefreshControl,
  StyleSheet, ActivityIndicator, Modal, AppState, Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Footprints, Zap, Target } from 'lucide-react-native';
import { supabase } from '../../lib/supabase';
import {
  getTodayHealthData, fetchTodayHealthData, fetchTodayWorkouts,
  type HealthData, type WearableHealthData,
} from '../../lib/healthKit';
import { fetchAllWhoopData, mergeWhoopIntoHealthData } from '../../lib/whoopApi';
import { computeTDEEFromProfile, getActivityMultiplier } from '../../lib/tdee';
import { calculatePeakScore, type PeakScoreResult } from '../../lib/peakScore';
import {
  getConnectedWearables,
  selectHRVSource, selectRHRSource,
  selectSleepSource, resolveAllSources,
} from '../../lib/wearablePriority';
import type { Program, ProgramDay, TabParamList } from '../_layout';
import { detectCandidates, getPendingCandidates, type CandidateRow } from '../../lib/sessionMatcher';
import WorkoutConfirmationCard from '../../components/WorkoutConfirmationCard';
import { Colors, Fonts, scoreColor } from '../../lib/theme';

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
  goal: string | null;
  chest_strap_tip_shown: boolean | null;
  coached_upsell_dismissed: boolean | null;
  whoop_connected: boolean | null;
  garmin_connected: boolean | null;
  coros_connected: boolean | null;
  manual_hrv: number | null;
  manual_hrv_date: string | null;
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

// ─── Daily health cache ───────────────────────────────────────────────────────

async function saveHealthCache(uid: string, rd: WearableHealthData, date: string): Promise<void> {
  await supabase.from('daily_health_readings').upsert({
    user_id:                uid,
    date,
    hrv:                    rd.hrv?.value             ?? null,
    hrv_source:             rd.hrv?.source            ?? null,
    resting_hr:             rd.restingHR?.value       ?? null,
    resting_hr_source:      rd.restingHR?.source      ?? null,
    sleep_hours:            rd.sleepHours?.value      ?? null,
    sleep_source:           rd.sleepHours?.source     ?? null,
    steps:                  rd.steps?.value           ?? null,
    steps_source:           rd.steps?.source          ?? null,
    active_calories:        rd.activeCalories?.value  ?? null,
    active_calories_source: rd.activeCalories?.source ?? null,
    total_calories:         rd.totalCalories?.value   ?? null,
    total_calories_source:  rd.totalCalories?.source  ?? null,
  }, { onConflict: 'user_id,date' });
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

// ─── Main component ───────────────────────────────────────────────────────────

export default function HomeScreen() {
  const navigation = useNavigation<BottomTabNavigationProp<TabParamList>>();

  const [userId, setUserId]               = useState('');
  const [program, setProgram]             = useState<Program | null>(null);
  const [todayDay, setTodayDay]           = useState<ProgramDay | null>(null);
  const [sessionCount, setSessionCount]   = useState(0);
  const [streak, setStreak]               = useState(0);
  const [loading, setLoading]             = useState(true);
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
  const [pendingCandidates, setPendingCandidates] = useState<CandidateRow[]>([]);
  const [refreshing, setRefreshing]               = useState(false);

  // ── Week 2 generation ────────────────────────────────────────────────────────

  async function checkAndTriggerWeek2(uid: string, prog: Program) {
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
    setLoading(true);
    const { data: authData } = await supabase.auth.getUser();
    if (!mounted.current || myId !== loadIdRef.current) return;
    if (!authData.user) { setLoading(false); return; }
    const uid = authData.user.id;
    setUserId(uid);

    const todayStr = new Date().toLocaleDateString('en-US', { weekday: 'long' });

    const [progsRes, logsRes, profileRes, extStreakRes, cacheRes] = await Promise.all([
      supabase.from('programs').select('*').eq('user_id', uid)
        .order('week_number', { ascending: true }),
      supabase.from('session_logs').select('completed_at')
        .eq('user_id', uid).order('completed_at', { ascending: false }),
      supabase.from('profiles')
        .select('wearable_connected, wearable_type, goal, goal_time, age, gender, height_cm, weight_kg, preferred_units, current_training_days, rest_days, body_weight, weight_unit, height, weight, units, chest_strap_tip_shown, coached_upsell_dismissed, whoop_connected, garmin_connected, coros_connected, manual_hrv, manual_hrv_date')
        .eq('id', uid)
        .maybeSingle(),
      supabase.from('external_workouts')
        .select('start_time')
        .eq('user_id', uid)
        .gte('start_time', new Date(Date.now() - 60 * 86_400_000).toISOString()),
      supabase.from('daily_health_readings')
        .select('*')
        .eq('user_id', uid)
        .order('date', { ascending: false })
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
      setTodayDay(prog.program_data.days.find(d => d.day === todayStr) ?? null);
    }

    setWeek2Exists(progs.some(p => p.week_number === 2));

    const logs = logsRes.data ?? [];
    setSessionCount(logs.length);

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

    const isElite = isEliteHyroxProfile(profileData?.goal ?? null, profileData?.goal_time ?? null);
    const newStreak = calculateStreakValue(sessionDates, externalDates, restDayNames, isElite);
    console.log('[streak] isEliteHyrox:', isElite, 'streak:', newStreak);
    setStreak(newStreak);
    const isHealthConnected =
      profileData?.wearable_connected === true &&
      profileData?.wearable_type === 'apple_health';
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

    // Apply cached health data immediately so metrics display before the background fetch.
    const cacheRow = cacheRes.data as Record<string, any> | null;
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
      console.log('[cache] applied daily_health_readings row from:', cacheRow.date);
    }
    // Show shimmer on metric cards while background fetch runs (only if no cache → no readinessData yet)
    if (isHealthConnected || isWhoopConnected) setFetchingFresh(true);

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
          if (!mounted.current || myId !== loadIdRef.current) return;
          console.log('[health] fetchTodayHealthData result:', JSON.stringify(rd));
          if (isWhoopConnected) {
            console.log('[health] Whoop also connected — fetching Whoop API to merge over HealthKit...');
            try {
              const whoopData = await fetchAllWhoopData(uid);
              if (!mounted.current || myId !== loadIdRef.current) return;
              console.log('[health] Whoop API data:', JSON.stringify(whoopData));
              rd = mergeWhoopIntoHealthData(rd, whoopData);
              console.log('[health] post-Whoop merge result:', JSON.stringify(rd));
            } catch (e) {
              console.log('[home] whoop merge error:', e);
            }
          }
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

    } else if (isWhoopConnected) {
      console.log('[health] Apple Health not connected — running Whoop-only path');
      (async () => {
        try {
          if (!mounted.current || myId !== loadIdRef.current) return;
          const whoopData = await fetchAllWhoopData(uid);
          if (!mounted.current || myId !== loadIdRef.current) return;
          console.log('[health] Whoop-only API data:', JSON.stringify(whoopData));
          const empty: WearableHealthData = {
            hrv: null, restingHR: null, sleepHours: null,
            steps: null, activeCalories: null, basalCalories: null, totalCalories: null,
          };
          const rd = mergeWhoopIntoHealthData(empty, whoopData);
          console.log('[health] Whoop-only merged readiness:', JSON.stringify(rd));
          setReadinessData(rd);
          setFetchingFresh(false);
          saveHealthCache(uid, rd, new Date().toLocaleDateString('en-CA')).catch(() => {});
          setHealthData({
            steps:             rd.steps?.value         ?? null,
            activeCalories:    rd.activeCalories?.value ?? null,
            totalCalories:     rd.totalCalories?.value  ?? null,
            restingHR:         rd.restingHR?.value      ?? null,
            hrv:               rd.hrv?.value            ?? null,
            sleepHours:        rd.sleepHours?.value     ?? null,
            exerciseMinutes:   null,
            lastActiveCalSync: null,
          });
          if (profileData) {
            const tdee = computeTDEEFromProfile(profileData);
            if (tdee.ok) {
              setTdeeBase(tdee.value);
              const tDays = profileData.current_training_days != null
                ? (parseInt(profileData.current_training_days, 10) || 4)
                : profileData.rest_days != null ? Math.max(0, 7 - profileData.rest_days) : 4;
              setBmr(Math.round(tdee.value / getActivityMultiplier(tDays)));
            }
            const wearables = getConnectedWearables(profileData);
            const base = tdee.ok ? tdee.value : null;
            const tDays2 = profileData.current_training_days != null
              ? (parseInt(profileData.current_training_days, 10) || 4)
              : profileData.rest_days != null ? Math.max(0, 7 - profileData.rest_days) : 4;
            const localBmr = base != null ? Math.round(base / getActivityMultiplier(tDays2)) : null;
            const sources = resolveAllSources(wearables, rd, profileData, base, localBmr);
            console.log('[home] Whoop-only totalCal final:', sources.totalCal.value, '| source:', sources.totalCal.source);
          }
          const hrv   = rd.hrv?.value       ?? null;
          const sleep = rd.sleepHours?.value ?? null;
          const rhr   = rd.restingHR?.value  ?? null;
          console.log('[home] Whoop-only readiness row final values:', { hrv, sleep, rhr });
        } catch (e) {
          console.log('[home] whoop-only fetch error:', e);
          setFetchingFresh(false);
        }
      })();
    } else {
      console.log('[health] no wearable connected — all metrics will show "--"');
    }

    if (prog?.week_number === 1 && !week2Exists && !week2TriggeredRef.current) {
      checkAndTriggerWeek2(uid, prog);
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

  const sessions  = todayDay?.sessions ?? [];
  const isRestDay = todayDay?.type === 'rest' || sessions.length === 0;

  const dayIndex = program?.program_data?.days?.findIndex(d => d.day === todayDay?.day) ?? -1;
  const dayLabel = dayIndex >= 0 ? `Day ${dayIndex + 1}` : (todayDay?.day ?? '');
  const typeLabel = todayDay?.type
    ? todayDay.type.charAt(0).toUpperCase() + todayDay.type.slice(1)
    : '';
  const sessionTitle = sessions.length === 1
    ? sessions[0].name
    : sessions.map(s => s.name).filter(Boolean).join(' + ');
  const workoutSummary = todayDay ? buildWorkoutSummary(todayDay) : '';

  const hasWearable = healthConnected || storedProfile?.whoop_connected === true;

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

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />}
      >

        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerLogo}>Peak 65</Text>
          <Text style={styles.headerDate}>{todayLabel()}</Text>
        </View>

        {/* Peak Score card */}
        {(() => {
          const borderColor = healthConnected && peakScore
            ? scoreColor(peakScore.score)
            : Colors.card;
          return (
            <View style={[styles.scoreCard, { borderColor }]}>
              <Text style={styles.scoreCardLabel}>PEAK SCORE</Text>
              {healthConnected && peakScore ? (
                <>
                  <Text style={[styles.scoreNum, { color: scoreColor(peakScore.score) }]}>
                    {peakScore.score}
                  </Text>
                  <Text style={styles.scoreCoach}>{peakScore.coachingLine}</Text>
                  {peakScore.baselineDay < 14 && (
                    <View style={styles.calibrationBar}>
                      <View style={[styles.calibrationFill, { width: `${(peakScore.baselineDay / 14) * 100}%` as any, backgroundColor: scoreColor(peakScore.score) }]} />
                    </View>
                  )}
                  <Text style={[styles.scoreWearable, { color: scoreColor(peakScore.score) }]}>
                    {peakScore.baselineDay < 14
                      ? `Calibrating — day ${peakScore.baselineDay} of 14`
                      : scoreStatusText(peakScore.score)}
                  </Text>
                </>
              ) : healthConnected ? (
                <>
                  <Text style={[styles.scoreNum, { color: Colors.textSecondary }]}>--</Text>
                  <Text style={styles.scoreCoach}>Loading your score...</Text>
                </>
              ) : (
                <>
                  <Text style={[styles.scoreNum, { color: Colors.textSecondary }]}>--</Text>
                  <Text style={styles.scoreCoach}>Track readiness daily.</Text>
                  <Text style={styles.scoreWearable}>Connect your wearable for live scores</Text>
                </>
              )}
            </View>
          );
        })()}

        {/* Streak + Sessions row */}
        <View style={styles.row}>
          <View style={[styles.miniCard, { flex: 1 }]}>
            <View style={styles.streakRow}>
              <Feather name="zap" color={Colors.accent} size={18} />
              <Text style={styles.streakNum}>{streak}</Text>
            </View>
            <Text style={styles.miniCardLabel}>Day Streak</Text>
            <Text style={styles.miniCardSub}>Keep your plan. Keep your streak.</Text>
          </View>
          <View style={[styles.miniCard, { flex: 1 }]}>
            <Text style={styles.streakNum}>{sessionCount}</Text>
            <Text style={styles.miniCardLabel}>Sessions</Text>
            <Text style={styles.miniCardSub}>Every rep counts.</Text>
          </View>
        </View>

        {/* Stats row — Steps | Active | Total */}
        <View style={styles.row}>
          {/* Steps */}
          <View style={[styles.statCard, { flex: 1 }]}>
            <Footprints color={Colors.textSecondary} size={20} strokeWidth={1.5} />
            {fetchingFresh && !readinessData && hasWearable ? (
              <ShimmerBox width={64} height={26} />
            ) : (
              <Text style={styles.statVal}>
                {hasWearable && healthData?.steps != null ? healthData.steps.toLocaleString('en-US') : '--'}
              </Text>
            )}
            <Text style={styles.statLabel}>Steps</Text>
            {!hasWearable && <Text style={styles.statSub}>Connect Health</Text>}
          </View>
          {/* Active Calories */}
          <View style={[styles.statCard, { flex: 1 }]}>
            <Zap color={Colors.textSecondary} size={20} strokeWidth={1.5} />
            {fetchingFresh && !readinessData && hasWearable ? (
              <ShimmerBox width={64} height={26} />
            ) : (
              <Text style={styles.statVal}>
                {hasWearable && healthData?.activeCalories != null ? `${healthData.activeCalories}` : '--'}
              </Text>
            )}
            <Text style={styles.statLabel}>Active</Text>
            {!hasWearable && <Text style={styles.statSub}>Connect Health</Text>}
          </View>
          {/* Total calories — Whoop cycle total or BMR + active projection */}
          {(() => {
            if (fetchingFresh && !readinessData && hasWearable) {
              return (
                <View style={[styles.statCard, { flex: 1 }]}>
                  <Target color={Colors.textSecondary} size={20} strokeWidth={1.5} />
                  <ShimmerBox width={64} height={26} />
                  <Text style={styles.statLabel}>Total</Text>
                </View>
              );
            }
            const whoopTotal = readinessData?.totalCalories?.source?.includes('Whoop')
              ? readinessData.totalCalories.value : null;
            if (whoopTotal != null) {
              console.log('[home] Total Cal display: Whoop cycle total:', whoopTotal);
              return (
                <View style={[styles.statCard, { flex: 1 }]}>
                  <Target color={Colors.textSecondary} size={20} strokeWidth={1.5} />
                  <Text style={styles.statVal}>{whoopTotal}</Text>
                  <Text style={styles.statLabel}>Total</Text>
                  <Text style={styles.statSub}>Whoop</Text>
                </View>
              );
            }
            const activeSoFar = hasWearable && healthData?.activeCalories != null ? healthData.activeCalories : null;
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
            if (!healthConnected || projected == null) {
              return (
                <View style={[styles.statCard, { flex: 1 }]}>
                  <Target color={Colors.textSecondary} size={20} strokeWidth={1.5} />
                  <Text style={styles.statVal}>--</Text>
                  <Text style={styles.statLabel}>Total</Text>
                  {!healthConnected && <Text style={styles.statSub}>Connect Health</Text>}
                </View>
              );
            }
            return (
              <View style={[styles.statCard, { flex: 1 }]}>
                <Target color={Colors.textSecondary} size={20} strokeWidth={1.5} />
                <Text style={styles.statVal}>{projected}</Text>
                <Text style={styles.statLabel}>Projected</Text>
                {currentBurn != null && <Text style={styles.statSub}>{currentBurn} so far</Text>}
                {syncTime && <Text style={styles.statSync}>synced {syncTime}</Text>}
              </View>
            );
          })()}
        </View>

        {/* Morning Readiness row — HRV | Sleep | RHR — always rendered */}
        {(() => {
          const hasWearableData = (healthConnected || storedProfile?.whoop_connected === true) && !!readinessData;
          const hrvR   = hasWearableData ? selectHRVSource(readinessData!, storedProfile ?? {}) : null;
          const sleepR = hasWearableData ? selectSleepSource(readinessData!) : null;
          const rhrR   = hasWearableData ? selectRHRSource(readinessData!) : null;
          const tiles = [
            { icon: 'heart' as const,    label: 'HRV',   reading: hrvR,   unit: 'ms' },
            { icon: 'moon' as const,     label: 'Sleep', reading: sleepR, unit: 'h' },
            { icon: 'activity' as const, label: 'RHR',   reading: rhrR,   unit: 'bpm' },
          ] as const;
          return (
            <View style={styles.row}>
              {tiles.map(t => (
                <TouchableOpacity
                  key={t.label}
                  style={[styles.statCard, { flex: 1 }]}
                  onPress={() => navigation.navigate('Profile')}
                  activeOpacity={0.75}
                >
                  <Feather name={t.icon} color={Colors.textSecondary} size={20} />
                  {t.reading && !t.reading.noWearable && t.reading.value != null ? (
                    <Text style={styles.recoveryVal}>
                      {t.label === 'Sleep'
                        ? t.reading.value.toFixed(1)
                        : Math.round(t.reading.value as number)}{t.unit}
                    </Text>
                  ) : fetchingFresh && !readinessData && hasWearable ? (
                    <ShimmerBox width={56} height={32} />
                  ) : (
                    <Text style={styles.connectWearable}>Connect wearable</Text>
                  )}
                  <Text style={styles.statLabel}>{t.label}</Text>
                  {t.reading && !t.reading.noWearable && t.reading.source ? (
                    <Text style={styles.readinessSource}>{t.reading.source}</Text>
                  ) : null}
                </TouchableOpacity>
              ))}
            </View>
          );
        })()}

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

        {/* ── TODAY ──────────────────────────────────────────────────────────── */}
        <Text style={styles.todayHeader}>TODAY</Text>

        {!todayDay ? (
          <View style={styles.emptyBlock}>
            <Text style={styles.emptyText}>No program found.</Text>
          </View>
        ) : isRestDay ? (
          <View style={styles.emptyBlock}>
            <Text style={styles.emptyText}>Rest day — recover well.</Text>
          </View>
        ) : (
          <TouchableOpacity
            style={styles.workoutCard}
            activeOpacity={0.85}
            onPress={() => navigation.navigate('Program')}
          >
            <View style={styles.workoutCardTop}>
              <Text style={styles.workoutDayLabel}>
                {dayLabel}{typeLabel ? ` — ${typeLabel}` : ''}
              </Text>
              <Text style={styles.workoutSessionTitle} numberOfLines={2}>{sessionTitle}</Text>
            </View>
            {!!workoutSummary && (
              <Text style={styles.workoutSummary} numberOfLines={1}>{workoutSummary}</Text>
            )}
            <View style={styles.viewWorkoutBtn}>
              <Text style={styles.viewWorkoutBtnText}>VIEW WORKOUT</Text>
            </View>
          </TouchableOpacity>
        )}

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

  // Peak Score card
  scoreCard: {
    margin: 16, backgroundColor: Colors.card, borderRadius: 16, padding: 24,
    alignItems: 'center', borderWidth: 1.5,
  },
  scoreCardLabel: {
    color: Colors.textSecondary, fontSize: 11, fontWeight: '600',
    letterSpacing: 1.5, textTransform: 'uppercase',
  },
  scoreNum: {
    fontFamily: Fonts.metricHeavy, fontSize: 80, lineHeight: 96,
  },
  scoreCoach: { color: Colors.textPrimary, fontSize: 14, textAlign: 'center', marginTop: 4 },
  scoreWearable: { color: Colors.textSecondary, fontSize: 12, textAlign: 'center', marginTop: 8, fontWeight: '600' },
  calibrationBar: {
    width: '100%', height: 4, backgroundColor: Colors.nested,
    borderRadius: 2, marginTop: 14, overflow: 'hidden',
  },
  calibrationFill: { height: '100%', borderRadius: 2 },

  // Mini + stat cards
  row: { flexDirection: 'row', paddingHorizontal: 16, gap: 10, marginBottom: 10 },
  miniCard: { backgroundColor: Colors.card, borderRadius: 14, padding: 16 },
  streakRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  streakNum: {
    fontFamily: Fonts.metric, fontSize: 32, color: Colors.textPrimary,
  },
  miniCardLabel: { color: Colors.textSecondary, fontSize: 12, fontWeight: '600', marginBottom: 2 },
  miniCardSub: { color: Colors.textSecondary, fontSize: 11 },
  statCard: {
    backgroundColor: Colors.card, borderRadius: 14, padding: 12, alignItems: 'center', gap: 4,
  },
  statVal: {
    fontFamily: Fonts.metric, color: Colors.textPrimary, fontSize: 26,
  },
  recoveryVal: {
    fontFamily: Fonts.metric, color: Colors.textPrimary, fontSize: 32,
  },
  statLabel: { color: Colors.textSecondary, fontSize: 11, fontWeight: '600' },
  statSub:  { color: Colors.textSecondary, fontSize: 10 },
  statSync: { color: Colors.textSecondary, fontSize: 9, marginTop: 1 },
  readinessSource:  { color: Colors.textSecondary, fontSize: 9, marginTop: 1, textAlign: 'center' },
  connectWearable:  { color: Colors.textSecondary, fontSize: 11, textAlign: 'center', marginTop: 1 },

  // Today section header
  todayHeader: {
    color: Colors.accent, fontSize: 11, fontWeight: '700', letterSpacing: 1.5,
    textTransform: 'uppercase', paddingHorizontal: 20, marginTop: 8, marginBottom: 12,
  },
  emptyBlock: { paddingHorizontal: 20, paddingVertical: 24 },
  emptyText: { color: Colors.textSecondary, fontSize: 15, textAlign: 'center' },

  // Compact workout card
  workoutCard: {
    marginHorizontal: 16, backgroundColor: Colors.card, borderRadius: 16, padding: 20,
    borderLeftWidth: 3, borderLeftColor: Colors.accent, gap: 12,
  },
  workoutCardTop: { gap: 4 },
  workoutDayLabel: {
    color: Colors.textSecondary, fontSize: 11, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 1,
  },
  workoutSessionTitle: { color: Colors.textPrimary, fontSize: 18, fontWeight: '800' },
  workoutSummary: { color: Colors.textSecondary, fontSize: 13, lineHeight: 18 },
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
