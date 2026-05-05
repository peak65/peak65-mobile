import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import {
  View, Text, ScrollView, TouchableOpacity, RefreshControl,
  StyleSheet, ActivityIndicator, Modal, AppState,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '../../lib/supabase';
import {
  getTodayHealthData, fetchTodayHealthData, fetchTodayWorkouts,
  type HealthData, type WearableHealthData,
} from '../../lib/healthKit';
import { fetchAllWhoopData, mergeWhoopIntoHealthData } from '../../lib/whoopApi';
import { computeTDEEFromProfile } from '../../lib/tdee';
import { calculatePeakScore, type PeakScoreResult } from '../../lib/peakScore';
import {
  getConnectedWearables,
  selectActiveCalorieSource, selectHRVSource, selectRHRSource,
  selectSleepSource, selectStepsSource, selectTotalCalorieSource,
  resolveAllSources, type WearableReading,
} from '../../lib/wearablePriority';
import type { Program, ProgramDay, TabParamList } from '../_layout';
import { detectCandidates, getPendingCandidates, type CandidateRow } from '../../lib/sessionMatcher';
import WorkoutConfirmationCard from '../../components/WorkoutConfirmationCard';

// ─── Constants ────────────────────────────────────────────────────────────────

const YELLOW    = '#e8ff47';
const BLACK     = '#080808';
const OFF_WHITE = '#f0ede8';
const GREY      = '#8a877f';
const CARD_BG   = '#111111';
const GREEN     = '#44ff88';
const RED       = '#ff4444';
const ORANGE    = '#ff9944';

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
  // TDEE fields
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

function scoreColor(s: number) {
  if (s >= 80) return GREEN;
  if (s >= 60) return YELLOW;
  return RED;
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
    if (i === 0)    { continue; } // today not yet logged — grace period
    break;
  }
  return streak;
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

    const [progsRes, logsRes, profileRes, extStreakRes] = await Promise.all([
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

    // Detect new workout candidates, then fetch pending ones for confirmation UI
    detectCandidates(uid)
      .then(() => getPendingCandidates(uid))
      .then(candidates => { if (mounted.current && myId === loadIdRef.current) setPendingCandidates(candidates); })
      .catch(e => console.log('[home] candidates error:', e));

    if (isHealthConnected) {
      // ── Apple Health path: HealthKit provides steps/calories; Whoop merges over top ─

      // Fetch simple numeric health data (steps, active cal, lastSync)
      getTodayHealthData()
        .then(async (data) => {
          if (!mounted.current || myId !== loadIdRef.current) return;
          console.log('[health] getTodayHealthData result:', JSON.stringify(data));
          setHealthData(data);

          // TDEE base
          if (profileData) {
            const tdee = computeTDEEFromProfile(profileData);
            if (tdee.ok) setTdeeBase(tdee.value);
          }

          // Live Peak Score
          const score = await calculatePeakScore(uid, {
            hrv: data.hrv,
            rhr: data.restingHR,
            sleepHours: data.sleepHours,
            activeCalories: data.activeCalories,
          });
          if (!mounted.current || myId !== loadIdRef.current) return;
          if (score) setPeakScore(score);

          // External workouts
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

      // Fetch richer readiness data (HRV/Sleep/RHR with wearable-priority sources)
      // then overlay Whoop API values if Whoop is also connected.
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
          if (profileData) {
            const wearables = getConnectedWearables(profileData);
            const tdee = computeTDEEFromProfile(profileData);
            const base = tdee.ok ? tdee.value : null;
            resolveAllSources(wearables, rd, profileData, base);
          }
          const hrv   = rd.hrv?.value         ?? null;
          const sleep = rd.sleepHours?.value   ?? null;
          const rhr   = rd.restingHR?.value    ?? null;
          console.log('[home] readiness row final values:', { hrv, sleep, rhr });
        })
        .catch(e => console.log('[home] readiness fetch error:', e));

    } else if (isWhoopConnected) {
      // ── Whoop-only path: Apple Health not connected, pull everything from Whoop API ─
      // Steps will be "--" (Whoop API has no steps endpoint); HRV/RHR/Sleep/Calories work.
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
          // Populate healthData so Steps/Active/Total tiles can render
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
            if (tdee.ok) setTdeeBase(tdee.value);
            const wearables = getConnectedWearables(profileData);
            const base = tdee.ok ? tdee.value : null;
            resolveAllSources(wearables, rd, profileData, base);
          }
          const hrv   = rd.hrv?.value       ?? null;
          const sleep = rd.sleepHours?.value ?? null;
          const rhr   = rd.restingHR?.value  ?? null;
          console.log('[home] Whoop-only readiness row final values:', { hrv, sleep, rhr });
        } catch (e) {
          console.log('[home] whoop-only fetch error:', e);
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

  // AppState: re-load when app returns to foreground
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
        <ActivityIndicator color={YELLOW} style={{ flex: 1 }} />
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
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={YELLOW} />}
      >

        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerLogo}>Peak 65</Text>
          <Text style={styles.headerDate}>{todayLabel()}</Text>
        </View>

        {/* Peak Score card */}
        <View style={styles.scoreCard}>
          <Text style={styles.scoreCardLabel}>PEAK SCORE</Text>
          {healthConnected && peakScore ? (
            <>
              <Text style={[styles.scoreNum, { color: scoreColor(peakScore.score) }]}>
                {peakScore.score}
              </Text>
              <Text style={styles.scoreCoach}>{peakScore.coachingLine}</Text>
              {peakScore.baselineDay < 14 && (
                <View style={styles.calibrationBar}>
                  <View style={[styles.calibrationFill, { width: `${(peakScore.baselineDay / 14) * 100}%` as any }]} />
                </View>
              )}
              <Text style={styles.scoreWearable}>
                {peakScore.baselineDay < 14
                  ? `Calibrating — day ${peakScore.baselineDay} of 14`
                  : peakScore.zone === 'peak' ? 'Peak Zone' : peakScore.zone === 'build' ? 'Build Zone' : 'Rest Zone'}
              </Text>
            </>
          ) : healthConnected ? (
            <>
              <Text style={[styles.scoreNum, { color: GREY }]}>--</Text>
              <Text style={styles.scoreCoach}>Loading your score...</Text>
            </>
          ) : (
            <>
              <Text style={[styles.scoreNum, { color: GREY }]}>--</Text>
              <Text style={styles.scoreCoach}>Track readiness daily.</Text>
              <Text style={styles.scoreWearable}>Connect your wearable for live scores</Text>
            </>
          )}
        </View>

        {/* Streak + Sessions row */}
        <View style={styles.row}>
          <View style={[styles.miniCard, { flex: 1 }]}>
            <Text style={styles.streakNum}>🔥 <Text style={{ color: YELLOW }}>{streak}</Text></Text>
            <Text style={styles.miniCardLabel}>Day Streak</Text>
            <Text style={styles.miniCardSub}>Keep your plan. Keep your streak.</Text>
          </View>
          <View style={[styles.miniCard, { flex: 1 }]}>
            <Text style={[styles.streakNum, { color: OFF_WHITE }]}>{sessionCount}</Text>
            <Text style={styles.miniCardLabel}>Sessions</Text>
            <Text style={styles.miniCardSub}>Every rep counts.</Text>
          </View>
        </View>

        {/* Stats row — Steps | Active | Total */}
        <View style={styles.row}>
          {[
            {
              emoji: '👟',
              label: 'Steps',
              val: (healthConnected || storedProfile?.whoop_connected === true) && healthData?.steps != null
                ? healthData.steps.toLocaleString('en-US') : '--',
            },
            {
              emoji: '💪',
              label: 'Active',
              val: (healthConnected || storedProfile?.whoop_connected === true) && healthData?.activeCalories != null
                ? `${healthData.activeCalories}` : '--',
            },
          ].map(s => (
            <View key={s.label} style={[styles.statCard, { flex: 1 }]}>
              <Text style={styles.statEmoji}>{s.emoji}</Text>
              <Text style={styles.statVal}>{s.val}</Text>
              <Text style={styles.statLabel}>{s.label}</Text>
              {!healthConnected && storedProfile?.whoop_connected !== true && (
                <Text style={styles.statSub}>Connect Health</Text>
              )}
            </View>
          ))}
          {/* 🔥 Total — Whoop strain + TDEE base (if connected) or TDEE projection */}
          {(() => {
            const whoopTotal = readinessData?.totalCalories?.source?.includes('Whoop')
              ? readinessData.totalCalories.value : null;
            if (whoopTotal != null) {
              return (
                <View style={[styles.statCard, { flex: 1 }]}>
                  <Text style={styles.statEmoji}>🔥</Text>
                  <Text style={styles.statVal}>{whoopTotal}</Text>
                  <Text style={styles.statLabel}>Total</Text>
                  <Text style={styles.statSub}>Whoop + Est.</Text>
                </View>
              );
            }
            const activeSoFar = (healthConnected || storedProfile?.whoop_connected === true) && healthData?.activeCalories != null ? healthData.activeCalories : null;
            const now          = new Date();
            const hoursElapsed = now.getHours() + now.getMinutes() / 60;
            const basalSoFar   = tdeeBase != null ? Math.round((tdeeBase / 24) * hoursElapsed) : null;
            const currentBurn  = basalSoFar != null && activeSoFar != null
              ? basalSoFar + activeSoFar
              : basalSoFar ?? null;
            const projected    = tdeeBase != null && activeSoFar != null ? tdeeBase + activeSoFar : null;
            const syncTime     = healthData?.lastActiveCalSync
              ? new Date(healthData.lastActiveCalSync).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
              : null;
            if (!healthConnected || projected == null) {
              return (
                <View style={[styles.statCard, { flex: 1 }]}>
                  <Text style={styles.statEmoji}>🔥</Text>
                  <Text style={styles.statVal}>--</Text>
                  <Text style={styles.statLabel}>Total</Text>
                  {!healthConnected && <Text style={styles.statSub}>Connect Health</Text>}
                </View>
              );
            }
            return (
              <View style={[styles.statCard, { flex: 1 }]}>
                <Text style={styles.statEmoji}>🔥</Text>
                <Text style={styles.statVal}>{projected}</Text>
                <Text style={styles.statLabel}>Projected</Text>
                {currentBurn != null && <Text style={styles.statSub}>{currentBurn} so far</Text>}
                {syncTime && <Text style={styles.statSync}>synced {syncTime}</Text>}
              </View>
            );
          })()}
        </View>

        {/* Morning Readiness row — HRV | Sleep | RHR */}
        {(healthConnected || storedProfile?.whoop_connected === true) && readinessData && (() => {
          const hrvR   = selectHRVSource(readinessData, storedProfile ?? {});
          const sleepR = selectSleepSource(readinessData);
          const rhrR   = selectRHRSource(readinessData);
          const tiles = [
            { emoji: '❤️', label: 'HRV',   reading: hrvR,   unit: 'ms' },
            { emoji: '😴', label: 'Sleep', reading: sleepR, unit: 'h' },
            { emoji: '💓', label: 'RHR',   reading: rhrR,   unit: 'bpm' },
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
                  <Text style={styles.statEmoji}>{t.emoji}</Text>
                  {t.reading.noWearable || t.reading.value == null ? (
                    <Text style={[styles.statVal, { color: GREY }]}>--</Text>
                  ) : (
                    <Text style={styles.statVal}>
                      {t.label === 'Sleep'
                        ? t.reading.value.toFixed(1)
                        : Math.round(t.reading.value as number)}{t.unit}
                    </Text>
                  )}
                  <Text style={styles.statLabel}>{t.label}</Text>
                  {!t.reading.noWearable && t.reading.source ? (
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
            <Text style={styles.chestStrapTitle}>💡 More accurate HR data</Text>
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
            <ActivityIndicator size="small" color={YELLOW} style={{ marginRight: 10 }} />
            <View>
              <Text style={styles.week2Title}>Building Week 2...</Text>
              <Text style={styles.week2Sub}>Your coach is reviewing your trial results.</Text>
            </View>
          </View>
        )}
        {week2Ready && !generatingWeek2 && (
          <View style={[styles.week2Banner, styles.week2BannerReady]}>
            <Text style={styles.week2ReadyIcon}>🗓</Text>
            <View>
              <Text style={[styles.week2Title, { color: GREEN }]}>Week 2 is ready.</Text>
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
  container: { flex: 1, backgroundColor: BLACK },

  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8,
  },
  headerLogo: { color: YELLOW, fontSize: 20, fontWeight: '800', letterSpacing: -0.5 },
  headerDate: { color: GREY, fontSize: 13 },

  // Peak Score card
  scoreCard: {
    margin: 16, backgroundColor: CARD_BG, borderRadius: 16, padding: 24, alignItems: 'center',
  },
  scoreCardLabel: { color: GREY, fontSize: 11, fontWeight: '600', letterSpacing: 1.5, textTransform: 'uppercase' },
  scoreNum: { fontSize: 80, fontWeight: '800', lineHeight: 96 },
  scoreCoach: { color: OFF_WHITE, fontSize: 14, textAlign: 'center', marginTop: 4 },
  scoreWearable: { color: GREY, fontSize: 11, textAlign: 'center', marginTop: 8 },
  calibrationBar: {
    width: '100%', height: 4, backgroundColor: '#2a2a2a',
    borderRadius: 2, marginTop: 14, overflow: 'hidden',
  },
  calibrationFill: { height: '100%', backgroundColor: YELLOW, borderRadius: 2 },

  // Mini + stat cards
  row: { flexDirection: 'row', paddingHorizontal: 16, gap: 10, marginBottom: 10 },
  miniCard: { backgroundColor: CARD_BG, borderRadius: 14, padding: 16 },
  streakNum: { fontSize: 32, fontWeight: '800', color: OFF_WHITE, marginBottom: 2 },
  miniCardLabel: { color: GREY, fontSize: 12, fontWeight: '600', marginBottom: 2 },
  miniCardSub: { color: GREY, fontSize: 11 },
  statCard: { backgroundColor: CARD_BG, borderRadius: 14, padding: 12, alignItems: 'center' },
  statEmoji: { fontSize: 22, marginBottom: 4 },
  statVal: { color: OFF_WHITE, fontSize: 18, fontWeight: '700' },
  statLabel: { color: GREY, fontSize: 11, fontWeight: '600', marginTop: 2 },
  statSub:  { color: GREY, fontSize: 10 },
  statSync: { color: GREY, fontSize: 9, marginTop: 1 },
  readinessSource: { color: GREY, fontSize: 9, marginTop: 1, textAlign: 'center' },

  // Today section header
  todayHeader: {
    color: YELLOW, fontSize: 11, fontWeight: '700', letterSpacing: 1.5,
    textTransform: 'uppercase', paddingHorizontal: 20, marginTop: 8, marginBottom: 12,
  },
  emptyBlock: { paddingHorizontal: 20, paddingVertical: 24 },
  emptyText: { color: GREY, fontSize: 15, textAlign: 'center' },

  // Compact workout card
  workoutCard: {
    marginHorizontal: 16, backgroundColor: CARD_BG, borderRadius: 16, padding: 20,
    borderLeftWidth: 3, borderLeftColor: YELLOW, gap: 12,
  },
  workoutCardTop: { gap: 4 },
  workoutDayLabel: {
    color: GREY, fontSize: 11, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 1,
  },
  workoutSessionTitle: { color: OFF_WHITE, fontSize: 18, fontWeight: '800' },
  workoutSummary: { color: GREY, fontSize: 13, lineHeight: 18 },
  viewWorkoutBtn: {
    backgroundColor: YELLOW, borderRadius: 10, paddingVertical: 13,
    alignItems: 'center', marginTop: 4,
  },
  viewWorkoutBtnText: { color: BLACK, fontSize: 14, fontWeight: '800', letterSpacing: 0.5 },

  // Off-program / extra workout card
  extraWorkoutCard: {
    marginHorizontal: 16, marginTop: 10, backgroundColor: CARD_BG,
    borderRadius: 16, padding: 20, borderLeftWidth: 3, borderLeftColor: ORANGE, gap: 8,
  },
  extraWorkoutHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  extraWorkoutBadge: {
    color: ORANGE, fontSize: 10, fontWeight: '700', letterSpacing: 1,
  },
  extraWorkoutType: { color: OFF_WHITE, fontSize: 16, fontWeight: '800' },
  extraWorkoutMeta:  { color: GREY, fontSize: 13 },
  extraWorkoutHR:    { color: GREY, fontSize: 12, marginTop: 2 },
  extraWorkoutCoach: { color: OFF_WHITE, fontSize: 13, lineHeight: 18 },
  acknowledgeBtn: {
    backgroundColor: '#1a1a1a', borderRadius: 10, paddingVertical: 11,
    alignItems: 'center', marginTop: 4, borderWidth: 1, borderColor: '#333',
  },
  acknowledgeBtnText: { color: GREY, fontSize: 13, fontWeight: '700', letterSpacing: 0.5 },

  // Primary button (milestone modal)
  primaryBtn: {
    backgroundColor: YELLOW, borderRadius: 12, paddingVertical: 16,
    alignItems: 'center', marginHorizontal: 16, marginBottom: 10,
  },
  primaryBtnText: { color: BLACK, fontSize: 16, fontWeight: '700' },

  // Milestone modal
  milestoneOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center', justifyContent: 'center', padding: 32,
  },
  milestoneCard: { alignItems: 'center', gap: 12, width: '100%' },
  milestoneEmoji: { fontSize: 64 },
  milestoneNum: { color: YELLOW, fontSize: 72, fontWeight: '800' },
  milestoneMsg: { color: OFF_WHITE, fontSize: 22, fontWeight: '700', textAlign: 'center' },
  milestoneSub: { color: GREY, fontSize: 15, textAlign: 'center', marginBottom: 16 },

  // Chest strap tip card
  chestStrapCard: {
    marginHorizontal: 16, marginTop: 10, backgroundColor: CARD_BG,
    borderRadius: 16, padding: 18, gap: 10,
    borderLeftWidth: 3, borderLeftColor: '#4488ff',
  },
  chestStrapTitle: { color: OFF_WHITE, fontSize: 14, fontWeight: '700' },
  chestStrapBody:  { color: GREY, fontSize: 13, lineHeight: 18 },
  chestStrapBtn: {
    backgroundColor: '#1a1a1a', borderRadius: 10, paddingVertical: 11,
    alignItems: 'center', borderWidth: 1, borderColor: '#333',
  },
  chestStrapBtnText: { color: GREY, fontSize: 13, fontWeight: '700', letterSpacing: 0.5 },

  // Week 2 banner
  week2Banner: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: 16, marginTop: 12, marginBottom: 4,
    backgroundColor: CARD_BG, borderRadius: 14, padding: 16,
    borderLeftWidth: 3, borderLeftColor: YELLOW,
  },
  week2BannerReady: { borderLeftColor: GREEN },
  week2ReadyIcon: { fontSize: 22, marginRight: 10 },
  week2Title: { color: YELLOW, fontSize: 14, fontWeight: '700', marginBottom: 2 },
  week2Sub:   { color: GREY, fontSize: 12 },
});
