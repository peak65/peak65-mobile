import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  StyleSheet, ActivityIndicator, Modal, Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '../../lib/supabase';
import type { Program, ProgramDay, ExerciseItem } from '../_layout';

// ─── Constants ────────────────────────────────────────────────────────────────

const YELLOW    = '#e8ff47';
const BLACK     = '#080808';
const OFF_WHITE = '#f0ede8';
const GREY      = '#8a877f';
const CARD_BG   = '#111111';
const GREEN     = '#44ff88';
const RED       = '#ff4444';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const MILESTONES: Record<number, { emoji: string; message: string; sub: string }> = {
  1:   { emoji: '🏆', message: 'First one down. The journey starts now.', sub: 'Session 1 complete.' },
  5:   { emoji: '🔥', message: '5 sessions. Consistency is forming.',       sub: 'Keep showing up.' },
  10:  { emoji: '⚡', message: '10 sessions. You\'re building something real.', sub: 'Double digits.' },
  25:  { emoji: '💪', message: '25 sessions. You\'re not who you were.',    sub: 'A quarter century.' },
  50:  { emoji: '🚀', message: '50 sessions. Half way to triple digits.',   sub: 'Unstoppable.' },
  100: { emoji: '👑', message: '100 sessions. Elite mindset. Proven.',      sub: 'Triple digits.' },
};

const SWAP_OPTIONS = [
  { emoji: '🎿', label: 'Ski Erg',      sub: 'Same stimulus, indoor' },
  { emoji: '🚣', label: 'Row Erg',      sub: 'Full body cardio alternative' },
  { emoji: '🚴', label: 'Assault Bike', sub: 'Zero impact, high output' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayLabel() {
  return new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function scoreColor(s: number) {
  if (s >= 80) return GREEN;
  if (s >= 50) return YELLOW;
  return RED;
}

function todayDayIndex(weekStartDate: string): number {
  const start = new Date(weekStartDate + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.floor((today.getTime() - start.getTime()) / 86_400_000);
  return diff >= 0 ? diff % 7 : new Date().getDay() === 0 ? 6 : new Date().getDay() - 1;
}

function fmtSeconds(s: number) {
  const m = Math.floor(s / 60).toString().padStart(2, '0');
  const sec = (s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ExerciseRow({ ex, phase }: { ex: ExerciseItem; phase: string }) {
  const borderColor = phase === 'main_work' ? YELLOW : GREY;
  let detail = '';
  if (ex.sets && ex.reps) detail = `${ex.sets} × ${ex.reps}`;
  else if (ex.reps) detail = ex.reps;
  else if (ex.distance || ex.zone || ex.duration) {
    detail = [ex.distance, ex.zone, ex.duration].filter(Boolean).join(' • ');
  }
  const note = ex.notes || ex.note;
  return (
    <View style={[styles.exRow, { borderLeftColor: borderColor }]}>
      <Text style={styles.exName}>{ex.name}</Text>
      {!!detail && <Text style={styles.exDetail}>{detail}</Text>}
      {!!note && <Text style={styles.exDetail}>{note}</Text>}
    </View>
  );
}

function SectionBlock({ label, items, phase }: { label: string; items: ExerciseItem[]; phase: string }) {
  if (!items?.length) return null;
  return (
    <View style={styles.sectionBlock}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {items.map((ex, i) => <ExerciseRow key={i} ex={ex} phase={phase} />)}
    </View>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function HomeScreen() {
  // Data
  const [program, setProgram]           = useState<Program | null>(null);
  const [todayDay, setTodayDay]         = useState<ProgramDay | null>(null);
  const [sessionCount, setSessionCount] = useState(0);
  const [streak, setStreak]             = useState(0);
  const [loading, setLoading]           = useState(true);
  const [userId, setUserId]             = useState<string | null>(null);

  // Swap run
  const [swapModalOpen, setSwapModalOpen] = useState(false);
  const [swappedCardio, setSwappedCardio] = useState<string | null>(null);

  // Milestone
  const [milestone, setMilestone] = useState<(typeof MILESTONES)[number] | null>(null);

  // Session logging
  const [sessionPhase, setSessionPhase] = useState<'idle' | 'active' | 'rpe' | 'saving'>('idle');
  const [sessionStartTime, setSessionStartTime] = useState<number>(0);
  const [elapsed, setElapsed]           = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Exercise tracking (set-by-set)
  const allExercises = todayDay
    ? (todayDay.sessions ?? []).flatMap(s =>
        (s.blocks ?? []).flatMap(b =>
          (b.exercises ?? []).map(e => ({ ...e, _phase: b.block_name }))
        )
      )
    : [];

  const [exIdx, setExIdx]               = useState(0);
  const [setIdx, setSetIdx]             = useState(0);
  const [restCountdown, setRestCountdown] = useState<number | null>(null);
  const [setWeight, setSetWeight]       = useState('');
  const [setReps, setSetReps]           = useState(0);
  const restRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // RPE
  const [rpe, setRpe]                   = useState(7);
  const [sessionNotes, setSessionNotes] = useState('');

  // ── Fetch data ──────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    setLoading(true);
    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) { setLoading(false); return; }
    setUserId(authData.user.id);

    const [programRes, logsRes] = await Promise.all([
      supabase.from('programs').select('*').eq('user_id', authData.user.id)
        .order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('session_logs').select('completed_at')
        .eq('user_id', authData.user.id).order('completed_at', { ascending: false }),
    ]);

    const prog = programRes.data as Program | null;
    setProgram(prog);

    if (prog?.program_data?.days) {
      const todayStr = new Date().toLocaleDateString('en-US', { weekday: 'long' });
      setTodayDay(prog.program_data.days.find(d => d.day === todayStr) ?? null);
    }

    const logs = logsRes.data ?? [];
    setSessionCount(logs.length);

    // Calculate streak (consecutive days from today backwards)
    const dates = [...new Set(logs.map(l =>
      new Date(l.completed_at).toLocaleDateString('en-CA')))].sort().reverse();
    let s = 0;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (let i = 0; i < dates.length; i++) {
      const d = new Date(dates[i] + 'T00:00:00');
      const diff = Math.floor((today.getTime() - d.getTime()) / 86_400_000);
      if (diff === i || diff === i + 1) s++;
      else break;
    }
    setStreak(s);

    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Session timer ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (sessionPhase === 'active') {
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - sessionStartTime) / 1000));
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [sessionPhase, sessionStartTime]);

  // ── Rest countdown ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (restCountdown === null) return;
    if (restCountdown <= 0) {
      setRestCountdown(null);
      advanceToNextSet();
      return;
    }
    restRef.current = setInterval(() => setRestCountdown(r => (r ?? 1) - 1), 1000);
    return () => { if (restRef.current) clearInterval(restRef.current); };
  }, [restCountdown]);

  // ── Session control ──────────────────────────────────────────────────────────

  function startSession() {
    setExIdx(0);
    setSetIdx(0);
    setRestCountdown(null);
    setSetWeight('');
    setSetReps(allExercises[0]?.type === 'strength' ? 0 : 0);
    setSessionStartTime(Date.now());
    setElapsed(0);
    setSessionPhase('active');
  }

  function advanceToNextSet() {
    const cur = allExercises[exIdx];
    const totalSets = (cur?.sets ?? 1);
    if (cur?.type === 'strength' && setIdx < totalSets - 1) {
      setSetIdx(i => i + 1);
      setSetWeight('');
      setSetReps(0);
    } else {
      advanceToNextExercise();
    }
  }

  function advanceToNextExercise() {
    if (exIdx < allExercises.length - 1) {
      setExIdx(i => i + 1);
      setSetIdx(0);
      setSetWeight('');
      setSetReps(0);
    } else {
      setSessionPhase('rpe');
    }
  }

  function handleLogSet() {
    const cur = allExercises[exIdx];
    const rest = cur?.rest_seconds;
    if (rest && rest > 0 && setIdx < (cur.sets ?? 1) - 1) {
      setRestCountdown(rest);
    } else {
      advanceToNextSet();
    }
  }

  async function handleCompleteSession() {
    if (!userId || !program) return;
    setSessionPhase('saving');

    const { data: result } = await supabase.from('session_logs').insert({
      user_id:      userId,
      program_id:   program.id,
      day_index:    todayDay?.day_index ?? 0,
      rpe,
      duration:     elapsed,
      notes:        sessionNotes.trim() || null,
      completed_at: new Date().toISOString(),
    }).select('id').single();

    if (result) {
      const newCount = sessionCount + 1;
      setSessionCount(newCount);
      if (MILESTONES[newCount]) setMilestone(MILESTONES[newCount]);
    }

    setSessionPhase('idle');
    setRpe(7);
    setSessionNotes('');
    setSwappedCardio(null);
  }

  // ── Swap run ─────────────────────────────────────────────────────────────────

  const hasCardio = false;

  // ── Render helpers ───────────────────────────────────────────────────────────

  const curEx = allExercises[exIdx] as (ExerciseItem & { _phase: string }) | undefined;

  function renderSessionOverlay() {
    if (sessionPhase === 'idle') return null;

    if (sessionPhase === 'rpe' || sessionPhase === 'saving') {
      return (
        <View style={styles.overlay}>
          <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
            <View style={styles.overlayInner}>
              <Text style={styles.overlayTitle}>How hard was that?</Text>
              <Text style={styles.rpeScore}>{rpe}</Text>
              <Text style={styles.rpeLabel}>
                {rpe <= 3 ? 'Easy' : rpe <= 6 ? 'Moderate' : rpe <= 8 ? 'Hard' : 'Max Effort'}
              </Text>
              <View style={styles.rpeRow}>
                {[1,2,3,4,5,6,7,8,9,10].map(n => (
                  <TouchableOpacity key={n} onPress={() => setRpe(n)}
                    style={[styles.rpeBtn, rpe === n && styles.rpeBtnActive]}>
                    <Text style={[styles.rpeBtnText, rpe === n && { color: BLACK }]}>{n}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TextInput
                style={styles.notesInput}
                placeholder="Notes (optional)"
                placeholderTextColor={GREY}
                value={sessionNotes}
                onChangeText={setSessionNotes}
                multiline
                selectionColor={YELLOW}
              />
              <TouchableOpacity
                style={[styles.primaryBtn, sessionPhase === 'saving' && { opacity: 0.5 }]}
                onPress={handleCompleteSession}
                disabled={sessionPhase === 'saving'}
              >
                <Text style={styles.primaryBtnText}>
                  {sessionPhase === 'saving' ? 'SAVING...' : 'COMPLETE SESSION'}
                </Text>
              </TouchableOpacity>
            </View>
          </SafeAreaView>
        </View>
      );
    }

    // Active session
    const phaseLabel = curEx?._phase === 'warm_up' ? 'WARM-UP'
      : curEx?._phase === 'cool_down' ? 'COOL-DOWN' : 'MAIN WORK';

    return (
      <View style={styles.overlay}>
        <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
          <View style={styles.overlayHeader}>
            <Text style={styles.timerText}>⏱ {fmtSeconds(elapsed)}</Text>
            <Text style={styles.exCounter}>
              {exIdx + 1} / {allExercises.length}
            </Text>
          </View>

          <View style={styles.overlayInner}>
            <Text style={styles.phaseChip}>{phaseLabel}</Text>

            {restCountdown !== null ? (
              <View style={styles.restView}>
                <Text style={styles.restLabel}>REST</Text>
                <Text style={styles.restTimer}>{fmtSeconds(restCountdown)}</Text>
                <TouchableOpacity onPress={() => { setRestCountdown(null); advanceToNextSet(); }}>
                  <Text style={styles.skipRest}>Skip rest →</Text>
                </TouchableOpacity>
              </View>
            ) : curEx?.type === 'strength' ? (
              <View style={{ width: '100%' }}>
                <Text style={styles.overlayTitle}>{curEx.name}</Text>
                <Text style={styles.setCounter}>
                  Set {setIdx + 1} of {curEx.sets ?? 1}
                </Text>
                <TextInput
                  style={styles.weightInput}
                  placeholder="Weight (lbs)"
                  placeholderTextColor={GREY}
                  value={setWeight}
                  onChangeText={setSetWeight}
                  keyboardType="decimal-pad"
                  selectionColor={YELLOW}
                />
                <View style={styles.repsRow}>
                  <TouchableOpacity style={styles.repBtn}
                    onPress={() => setSetReps(r => Math.max(0, r - 1))}>
                    <Text style={styles.repBtnText}>−</Text>
                  </TouchableOpacity>
                  <Text style={styles.repCount}>{setReps}</Text>
                  <TouchableOpacity style={styles.repBtn}
                    onPress={() => setSetReps(r => r + 1)}>
                    <Text style={styles.repBtnText}>+</Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.repHint}>reps</Text>
                <TouchableOpacity style={styles.primaryBtn} onPress={handleLogSet}>
                  <Text style={styles.primaryBtnText}>LOG SET</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={{ width: '100%', alignItems: 'center' }}>
                <Text style={styles.overlayTitle}>{curEx?.name}</Text>
                {!!curEx?.zone && <Text style={styles.exDetail}>{curEx.zone}</Text>}
                {!!curEx?.duration && <Text style={styles.exDetail}>{curEx.duration}</Text>}
                {!!curEx?.distance && <Text style={styles.exDetail}>{curEx.distance}</Text>}
                <TouchableOpacity style={[styles.primaryBtn, { marginTop: 32 }]}
                  onPress={advanceToNextExercise}>
                  <Text style={styles.primaryBtnText}>COMPLETE</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </SafeAreaView>
      </View>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <ActivityIndicator color={YELLOW} style={{ flex: 1 }} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Session overlay */}
      {renderSessionOverlay()}

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

      {/* Swap run modal */}
      <Modal transparent visible={swapModalOpen} animationType="slide">
        <TouchableOpacity style={styles.swapBackdrop} activeOpacity={1}
          onPress={() => setSwapModalOpen(false)}>
          <View style={styles.swapSheet}>
            <Text style={styles.swapTitle}>Swap today's run for:</Text>
            {SWAP_OPTIONS.map(opt => (
              <TouchableOpacity key={opt.label} style={styles.swapOption}
                onPress={() => { setSwappedCardio(opt.label); setSwapModalOpen(false); }}>
                <Text style={styles.swapEmoji}>{opt.emoji}</Text>
                <View>
                  <Text style={styles.swapLabel}>{opt.label}</Text>
                  <Text style={styles.swapSub}>{opt.sub}</Text>
                </View>
              </TouchableOpacity>
            ))}
            <TouchableOpacity onPress={() => setSwapModalOpen(false)} style={{ marginTop: 8 }}>
              <Text style={styles.cancelText}>CANCEL</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerLogo}>Peak 65</Text>
          <Text style={styles.headerDate}>{todayLabel()}</Text>
        </View>

        {/* 65 Score card */}
        <View style={styles.scoreCard}>
          <Text style={styles.scoreCardLabel}>65 SCORE</Text>
          <Text style={[styles.scoreNum, { color: scoreColor(72) }]}>72</Text>
          <Text style={styles.scoreCoach}>Train smart — listen to your body.</Text>
          <Text style={styles.scoreWearable}>Connect your wearable for live scores</Text>
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

        {/* Stats row */}
        <View style={styles.row}>
          {[
            { emoji: '👟', label: 'Steps',    val: '--' },
            { emoji: '🔥', label: 'Calories', val: '--' },
            { emoji: '⏱',  label: 'Active',   val: '--' },
          ].map(s => (
            <View key={s.label} style={[styles.statCard, { flex: 1 }]}>
              <Text style={styles.statEmoji}>{s.emoji}</Text>
              <Text style={styles.statVal}>{s.val}</Text>
              <Text style={styles.statLabel}>{s.label}</Text>
              <Text style={styles.statSub}>Connect Health</Text>
            </View>
          ))}
        </View>

        {/* Today's workout */}
        <Text style={styles.todayHeader}>TODAY</Text>
        {!todayDay ? (
          <View style={styles.noProgram}>
            <Text style={styles.noProgramText}>No program found.</Text>
          </View>
        ) : todayDay.type === 'rest' || !todayDay.sessions?.length ? (
          <View style={styles.noProgram}>
            <Text style={styles.noProgramText}>Rest day — recover well.</Text>
          </View>
        ) : (
          <>
            {(todayDay.sessions ?? []).map((session, si) => (
              <View key={si}>
                <View style={styles.sessionHeader}>
                  <Text style={styles.sessionName}>{session.name}</Text>
                  <Text style={styles.sessionMeta}>{session.time} · {session.duration_minutes} min</Text>
                </View>
                {!!session.description && (
                  <Text style={styles.sessionDesc}>{session.description}</Text>
                )}
                <View style={styles.sessionCard}>
                  {(session.blocks ?? []).map((block, bi) => (
                    <SectionBlock key={bi} label={block.block_name} items={block.exercises} phase="main_work" />
                  ))}
                </View>
              </View>
            ))}

            {sessionPhase === 'idle' ? (
              <TouchableOpacity style={styles.primaryBtn} onPress={startSession}>
                <Text style={styles.primaryBtnText}>START SESSION</Text>
              </TouchableOpacity>
            ) : (
              <View style={[styles.primaryBtn, { opacity: 0.6 }]}>
                <Text style={styles.primaryBtnText}>IN PROGRESS • {fmtSeconds(elapsed)}</Text>
              </View>
            )}
          </>
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

  // Score card
  scoreCard: {
    margin: 16, backgroundColor: CARD_BG, borderRadius: 16, padding: 24, alignItems: 'center',
  },
  scoreCardLabel: { color: GREY, fontSize: 11, fontWeight: '600', letterSpacing: 1.5, textTransform: 'uppercase' },
  scoreNum: { fontSize: 80, fontWeight: '800', lineHeight: 96 },
  scoreCoach: { color: OFF_WHITE, fontSize: 14, textAlign: 'center', marginTop: 4 },
  scoreWearable: { color: GREY, fontSize: 11, textAlign: 'center', marginTop: 8 },

  // Mini cards
  row: { flexDirection: 'row', paddingHorizontal: 16, gap: 10, marginBottom: 10 },
  miniCard: {
    backgroundColor: CARD_BG, borderRadius: 14, padding: 16,
  },
  streakNum: { fontSize: 32, fontWeight: '800', color: OFF_WHITE, marginBottom: 2 },
  miniCardLabel: { color: GREY, fontSize: 12, fontWeight: '600', marginBottom: 2 },
  miniCardSub: { color: GREY, fontSize: 11 },

  // Stat cards
  statCard: {
    backgroundColor: CARD_BG, borderRadius: 14, padding: 12, alignItems: 'center',
  },
  statEmoji: { fontSize: 22, marginBottom: 4 },
  statVal: { color: OFF_WHITE, fontSize: 18, fontWeight: '700' },
  statLabel: { color: GREY, fontSize: 11, fontWeight: '600', marginTop: 2 },
  statSub: { color: GREY, fontSize: 10 },

  // Today section
  todayHeader: {
    color: YELLOW, fontSize: 11, fontWeight: '700', letterSpacing: 1.5,
    textTransform: 'uppercase', paddingHorizontal: 20, marginTop: 8, marginBottom: 4,
  },
  todaySubtitle: { color: GREY, fontSize: 13, paddingHorizontal: 20, marginBottom: 12 },

  sessionCard: {
    marginHorizontal: 16, backgroundColor: CARD_BG, borderRadius: 16, padding: 16,
    gap: 16, marginBottom: 14,
  },
  sectionBlock: { gap: 8 },
  sectionLabel: {
    color: GREY, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase',
  },
  exRow: { borderLeftWidth: 3, paddingLeft: 10, gap: 2 },
  exName: { color: OFF_WHITE, fontSize: 15, fontWeight: '600' },
  exDetail: { color: GREY, fontSize: 13 },

  sessionHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline',
    paddingHorizontal: 20, marginBottom: 6,
  },
  sessionName: { color: OFF_WHITE, fontSize: 16, fontWeight: '700', flex: 1 },
  sessionMeta: { color: GREY, fontSize: 12 },
  sessionDesc: { color: GREY, fontSize: 13, paddingHorizontal: 20, marginBottom: 12, lineHeight: 18 },

  noProgram: { paddingHorizontal: 20, paddingVertical: 24 },
  noProgramText: { color: GREY, fontSize: 15, textAlign: 'center' },

  // Buttons
  primaryBtn: {
    backgroundColor: YELLOW, borderRadius: 12, paddingVertical: 16,
    alignItems: 'center', marginHorizontal: 16, marginBottom: 10,
  },
  primaryBtnText: { color: BLACK, fontSize: 16, fontWeight: '700' },

  swapBtn: {
    borderWidth: 1, borderColor: YELLOW, borderRadius: 12, paddingVertical: 14,
    alignItems: 'center', marginHorizontal: 16, marginBottom: 10,
  },
  swapBtnText: { color: YELLOW, fontSize: 15, fontWeight: '700' },

  // Session overlay
  overlay: {
    ...StyleSheet.absoluteFillObject, backgroundColor: BLACK, zIndex: 10,
  },
  overlayHeader: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingHorizontal: 24, paddingTop: 16, paddingBottom: 8,
  },
  timerText: { color: YELLOW, fontSize: 16, fontWeight: '700' },
  exCounter: { color: GREY, fontSize: 14 },
  overlayInner: {
    flex: 1, paddingHorizontal: 24, justifyContent: 'center', alignItems: 'center',
  },
  overlayTitle: { color: OFF_WHITE, fontSize: 26, fontWeight: '700', textAlign: 'center', marginBottom: 8 },
  phaseChip: {
    color: GREY, fontSize: 11, fontWeight: '700', letterSpacing: 1.5,
    textTransform: 'uppercase', marginBottom: 24,
  },
  setCounter: { color: GREY, fontSize: 14, textAlign: 'center', marginBottom: 20 },
  weightInput: {
    backgroundColor: CARD_BG, borderWidth: 1, borderColor: '#262626',
    borderRadius: 10, paddingHorizontal: 16, paddingVertical: 14,
    color: OFF_WHITE, fontSize: 18, width: '100%', marginBottom: 16,
  },
  repsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 24, marginBottom: 4 },
  repBtn: { backgroundColor: CARD_BG, width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  repBtnText: { color: OFF_WHITE, fontSize: 28, fontWeight: '300' },
  repCount: { color: OFF_WHITE, fontSize: 48, fontWeight: '700', minWidth: 60, textAlign: 'center' },
  repHint: { color: GREY, fontSize: 13, textAlign: 'center', marginBottom: 32 },

  restView: { alignItems: 'center', gap: 12 },
  restLabel: { color: GREY, fontSize: 13, fontWeight: '700', letterSpacing: 1.5 },
  restTimer: { color: YELLOW, fontSize: 72, fontWeight: '800' },
  skipRest: { color: GREY, fontSize: 14, textDecorationLine: 'underline' },

  // RPE
  rpeScore: { color: YELLOW, fontSize: 72, fontWeight: '800', textAlign: 'center' },
  rpeLabel: { color: GREY, fontSize: 16, textAlign: 'center', marginBottom: 24 },
  rpeRow: { flexDirection: 'row', gap: 6, marginBottom: 24, flexWrap: 'wrap', justifyContent: 'center' },
  rpeBtn: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: CARD_BG,
    alignItems: 'center', justifyContent: 'center',
  },
  rpeBtnActive: { backgroundColor: YELLOW },
  rpeBtnText: { color: OFF_WHITE, fontSize: 15, fontWeight: '600' },
  notesInput: {
    backgroundColor: CARD_BG, borderWidth: 1, borderColor: '#262626',
    borderRadius: 10, paddingHorizontal: 16, paddingVertical: 12,
    color: OFF_WHITE, fontSize: 15, width: '100%', minHeight: 60, marginBottom: 20,
  },

  // Milestone
  milestoneOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center', padding: 32,
  },
  milestoneCard: { alignItems: 'center', gap: 12, width: '100%' },
  milestoneEmoji: { fontSize: 64 },
  milestoneNum: { color: YELLOW, fontSize: 72, fontWeight: '800' },
  milestoneMsg: { color: OFF_WHITE, fontSize: 22, fontWeight: '700', textAlign: 'center' },
  milestoneSub: { color: GREY, fontSize: 15, textAlign: 'center', marginBottom: 16 },

  // Swap modal
  swapBackdrop: { flex: 1, justifyContent: 'flex-end' },
  swapSheet: {
    backgroundColor: CARD_BG, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 24, gap: 12,
  },
  swapTitle: { color: OFF_WHITE, fontSize: 16, fontWeight: '700', marginBottom: 8 },
  swapOption: {
    flexDirection: 'row', alignItems: 'center', gap: 16,
    backgroundColor: '#1a1a1a', borderRadius: 12, padding: 16,
  },
  swapEmoji: { fontSize: 28 },
  swapLabel: { color: OFF_WHITE, fontSize: 16, fontWeight: '600' },
  swapSub: { color: GREY, fontSize: 13 },
  cancelText: { color: GREY, fontSize: 15, textAlign: 'center', paddingVertical: 8 },
});
