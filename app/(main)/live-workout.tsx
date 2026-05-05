/**
 * Live Workout Screen
 * Guided step-by-step session execution.
 *
 * expo-keep-awake is required for screen-on behaviour:
 *   Run: npx expo install expo-keep-awake
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  TextInput, Modal, Vibration, Alert, KeyboardAvoidingView,
  Platform, StatusBar,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Audio } from 'expo-av';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList, ProgramSession, SessionBlock, ExerciseItem } from '../_layout';
import { supabase } from '../../lib/supabase';
import { Feather } from '@expo/vector-icons';
import { Colors, Fonts } from '../../lib/theme';

// Optional keep-awake — requires: npx expo install expo-keep-awake
function useKeepAwake() {
  useEffect(() => {
    let deactivate: (() => void) | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const kaw = require('expo-keep-awake');
      kaw.activateKeepAwakeAsync?.();
      deactivate = () => kaw.deactivateKeepAwakeAsync?.();
    } catch {}
    return () => { deactivate?.(); };
  }, []);
}


type Nav   = NativeStackNavigationProp<MainStackParamList, 'LiveWorkout'>;
type Route = RouteProp<MainStackParamList, 'LiveWorkout'>;

// ─── Step types ───────────────────────────────────────────────────────────────

type StepKind =
  | 'generic'       // warm-up / cool-down exercise, tap DONE
  | 'run_interval'  // single run interval with pace target
  | 'rest'          // timed rest
  | 'transition'    // between run and strength phases
  | 'strength'      // one set of a strength exercise
  | 'metcon'        // full metcon block (AMRAP / EMOM / Rounds)
  | 'z2_cardio';    // Z2 session with elapsed timer

type Step =
  | { kind: 'generic';      exercise: ExerciseItem; blockName: string }
  | { kind: 'run_interval'; exercise: ExerciseItem; intervalNum: number; totalIntervals: number; blockName: string }
  | { kind: 'rest';         seconds: number; label: string }
  | { kind: 'transition';   from: string; to: string; seconds: number }
  | { kind: 'strength';     exercise: ExerciseItem; setNum: number; totalSets: number; blockName: string }
  | { kind: 'metcon';       block: SessionBlock; format: 'amrap' | 'emom' | 'rounds'; timeCap: number }
  | { kind: 'z2_cardio';    session: ProgramSession };

type LoggedSet = { exerciseName: string; set: number; weight: string; reps: string };
type MetconRound = { round: number; completedAt: number };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseRestSeconds(rest: string | undefined, defaultSecs = 60): number {
  if (!rest) return defaultSecs;
  const s = rest.toLowerCase().trim();
  if (s.includes('as needed')) return 60;
  const range = s.match(/^(\d+)\s*[-–]\s*\d+\s*min/);
  if (range) return parseInt(range[1]) * 60;
  const colon = s.match(/^(\d+):(\d+)$/);
  if (colon) return parseInt(colon[1]) * 60 + parseInt(colon[2]);
  const mins = s.match(/(\d+)\s*min/);
  const secs = s.match(/(\d+)\s*s(?:ec)?/);
  let t = 0;
  if (mins) t += parseInt(mins[1]) * 60;
  if (secs) t += parseInt(secs[1]);
  if (!t) { const n = parseInt(s); if (!isNaN(n)) t = n; }
  return t || defaultSecs;
}

function generateWavUri(freqHz: number, durationMs: number): string {
  const sampleRate = 22050;
  const numSamples = Math.round(sampleRate * durationMs / 1000);
  const dataBytes  = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v   = new DataView(buf);
  v.setUint32(0,  0x52494646, false); // RIFF
  v.setUint32(4,  36 + dataBytes, true);
  v.setUint32(8,  0x57415645, false); // WAVE
  v.setUint32(12, 0x666d7420, false); // fmt
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);           // PCM
  v.setUint16(22, 1, true);           // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  v.setUint32(36, 0x64617461, false); // data
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < numSamples; i++) {
    const t    = i / sampleRate;
    const fade = i < numSamples * 0.1 ? i / (numSamples * 0.1)
               : i > numSamples * 0.8 ? (numSamples - i) / (numSamples * 0.2) : 1;
    v.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * freqHz * t) * 16383 * fade), true);
  }
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return 'data:audio/wav;base64,' + btoa(binary);
}

async function playBeep(freqHz: number, durationMs: number): Promise<void> {
  try {
    const uri = generateWavUri(freqHz, durationMs);
    const { sound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: true });
    sound.setOnPlaybackStatusUpdate(status => {
      if (status.isLoaded && status.didJustFinish) sound.unloadAsync().catch(() => {});
    });
  } catch {}
}

function isRunExercise(ex: ExerciseItem): boolean {
  const reps = String(ex.reps ?? '');
  if (/\d+\s*(km|m\b|800|400|200|1k|mile|min|sec)/i.test(reps)) return true;
  if (/run|erg|ski|interval|tempo|threshold|z2|zone/i.test(ex.name)) return true;
  return false;
}

function isStrengthExercise(ex: ExerciseItem, blockName: string): boolean {
  if (/warm|cool/i.test(blockName)) return false;
  if (!ex.sets || ex.sets < 1) return false;
  const reps = String(ex.reps ?? '');
  return /^\d+$/.test(reps.trim()) || /\d+\s*reps?/i.test(reps);
}

function classifyBlock(block: SessionBlock): 'warmup' | 'cooldown' | 'run' | 'strength' | 'metcon' | 'mixed' {
  const bn = block.block_name.toLowerCase();
  if (/warm/i.test(bn)) return 'warmup';
  if (/cool/i.test(bn)) return 'cooldown';
  if (/amrap|emom|metcon|rounds\s+for|rnds/i.test(bn)) return 'metcon';
  const exes = block.exercises ?? [];
  const runCount      = exes.filter(e => isRunExercise(e)).length;
  const strengthCount = exes.filter(e => isStrengthExercise(e, block.block_name)).length;
  if (runCount > 0 && strengthCount === 0) return 'run';
  if (strengthCount > 0 && runCount === 0) return 'strength';
  return 'mixed';
}

function detectMetconFormat(block: SessionBlock): 'amrap' | 'emom' | 'rounds' {
  const bn = block.block_name.toLowerCase();
  if (/amrap/i.test(bn)) return 'amrap';
  if (/emom/i.test(bn)) return 'emom';
  return 'rounds';
}

function extractTimeCap(block: SessionBlock): number {
  const match = block.block_name.match(/\d+/);
  return match ? parseInt(match[0]) * 60 : 12 * 60;
}

function isZ2Session(session: ProgramSession): boolean {
  return /z2|zone\s*2|easy|aerobic/i.test(session.name) &&
    (session.blocks ?? []).every(b =>
      /warm|cool|z2|zone|easy|aerobic/i.test(b.block_name)
    );
}

function extractPaceTarget(exercise: ExerciseItem): string | null {
  const note = exercise.notes || exercise.note || '';
  const m = note.match(/Target:\s*([0-9]:[\d:]+\/k[m]?)/i) ||
            note.match(/(\d:\d{2}\/km)/i) ||
            note.match(/(\d:\d{2}\/mi)/i);
  return m ? m[1] ?? m[0] ?? null : null;
}

function buildSteps(session: ProgramSession): Step[] {
  const steps: Step[] = [];

  if (isZ2Session(session)) {
    steps.push({ kind: 'z2_cardio', session });
    return steps;
  }

  const blocks = session.blocks ?? [];
  let prevKind: string | null = null;

  for (let bi = 0; bi < blocks.length; bi++) {
    const block   = blocks[bi];
    const bKind   = classifyBlock(block);
    const exercises = block.exercises ?? [];

    if (bKind === 'warmup' || bKind === 'cooldown') {
      for (const ex of exercises) {
        steps.push({ kind: 'generic', exercise: ex, blockName: block.block_name });
      }
      continue;
    }

    if (bKind === 'metcon') {
      // Insert transition if coming from run or strength
      if (prevKind === 'run' || prevKind === 'strength') {
        steps.push({ kind: 'transition', from: prevKind === 'run' ? 'Run' : 'Strength', to: 'Metcon', seconds: 60 });
      }
      steps.push({ kind: 'metcon', block, format: detectMetconFormat(block), timeCap: extractTimeCap(block) });
      prevKind = 'metcon';
      continue;
    }

    // For run or strength (or mixed), look at each exercise
    let blockHadRun = false;
    let blockHadStrength = false;

    for (const ex of exercises) {
      if (isRunExercise(ex)) {
        // If we just transitioned from non-run to run (not warmup), add a transition
        if (prevKind === 'strength') {
          steps.push({ kind: 'transition', from: 'Strength', to: 'Run', seconds: 60 });
        }
        const total = ex.sets ?? 1;
        for (let i = 0; i < total; i++) {
          steps.push({ kind: 'run_interval', exercise: ex, intervalNum: i + 1, totalIntervals: total, blockName: block.block_name });
          if (i < total - 1) {
            steps.push({ kind: 'rest', seconds: parseRestSeconds(ex.rest, 120), label: 'Recovery' });
          }
        }
        blockHadRun = true;
      } else if (isStrengthExercise(ex, block.block_name)) {
        // If transitioning from run block to strength
        if (blockHadRun || prevKind === 'run') {
          steps.push({ kind: 'transition', from: 'Run', to: 'Strength', seconds: 90 });
          blockHadRun = false;
        }
        const total = ex.sets ?? 1;
        for (let s = 0; s < total; s++) {
          steps.push({ kind: 'strength', exercise: ex, setNum: s + 1, totalSets: total, blockName: block.block_name });
          if (s < total - 1) {
            steps.push({ kind: 'rest', seconds: parseRestSeconds(ex.rest, 90), label: ex.rest ?? 'Rest' });
          }
        }
        blockHadStrength = true;
      } else {
        // Unrecognized exercise in main work — show generically
        steps.push({ kind: 'generic', exercise: ex, blockName: block.block_name });
      }
    }

    if (blockHadRun) prevKind = 'run';
    else if (blockHadStrength) prevKind = 'strength';
  }

  return steps;
}

function formatTime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.min(done / total, 1) : 0;
  return (
    <View style={pb.track}>
      <View style={[pb.fill, { width: `${Math.round(pct * 100)}%` as unknown as number }]} />
    </View>
  );
}
const pb = StyleSheet.create({
  track: { height: 3, backgroundColor: '#222', width: '100%' },
  fill:  { height: 3, backgroundColor: Colors.accent },
});

function RestCountdown({ seconds, label, onSkip }: { seconds: number; label: string; onSkip: () => void }) {
  const [rem, setRem] = useState(seconds);
  useEffect(() => { setRem(seconds); }, [seconds]);
  useEffect(() => {
    if (rem <= 0) {
      try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}); } catch {}
      playBeep(880, 400);
      Vibration.vibrate([0, 200, 100, 200]);
      onSkip();
      return;
    }
    if (rem === 3) {
      try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}); } catch {}
      playBeep(440, 150);
    }
    const id = setTimeout(() => setRem(r => r - 1), 1000);
    return () => clearTimeout(id);
  }, [rem, onSkip]);
  const pct = seconds > 0 ? Math.min((seconds - rem) / seconds, 1) : 1;
  return (
    <View style={rc.container}>
      <Text style={rc.restLabel}>REST</Text>
      <Text style={rc.countdown}>{formatTime(rem)}</Text>
      <View style={rc.progressTrack}>
        <View style={[rc.progressFill, { width: `${Math.round(pct * 100)}%` as unknown as number }]} />
      </View>
      <Text style={rc.restNote}>{label}</Text>
      <TouchableOpacity style={rc.skip} onPress={onSkip}>
        <Text style={rc.skipText}>Skip rest</Text>
      </TouchableOpacity>
    </View>
  );
}
const rc = StyleSheet.create({
  container:     { flex: 1, justifyContent: 'center', alignItems: 'center' },
  restLabel:     { color: Colors.textSecondary, fontSize: 12, fontWeight: '700', letterSpacing: 2, marginBottom: 12 },
  countdown:     { color: Colors.accent, fontSize: 88, fontFamily: Fonts.metricHeavy, fontVariant: ['tabular-nums' as const] },
  progressTrack: { width: '60%', height: 3, backgroundColor: '#222', borderRadius: 2, marginTop: 16, overflow: 'hidden' },
  progressFill:  { height: 3, backgroundColor: Colors.accent, borderRadius: 2 },
  restNote:      { color: Colors.textSecondary, fontSize: 13, marginTop: 16, textAlign: 'center', paddingHorizontal: 32 },
  skip:          { marginTop: 40 },
  skipText:      { color: Colors.textSecondary, fontSize: 13, fontWeight: '600' },
});

function SwapSheet({ visible, onClose, onSelect }: { visible: boolean; onClose: () => void; onSelect: (l: string) => void }) {
  const OPTIONS = [
    { label: 'Row Erg',         note: 'Same duration. Same HR zone target.' },
    { label: 'Ski Erg',         note: 'Same duration. Hard but controlled.' },
    { label: 'Assault Bike',    note: 'Same duration. RPE matches original.' },
    { label: 'Stationary Bike', note: 'Same duration. +30% distance equivalent.' },
    { label: 'Swim',            note: 'Same duration. ÷4 distance, technique focus.' },
  ];
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={sw.backdrop} activeOpacity={1} onPress={onClose} />
      <View style={sw.sheet}>
        <Text style={sw.title}>SWAP RUN</Text>
        <Text style={sw.sub}>Same duration, same zone. Choose your machine.</Text>
        {OPTIONS.map(o => (
          <TouchableOpacity key={o.label} style={sw.row} onPress={() => { onSelect(o.label); onClose(); }}>
            <Text style={sw.optLabel}>{o.label}</Text>
            <Text style={sw.optNote}>{o.note}</Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity style={sw.cancel} onPress={onClose}>
          <Text style={sw.cancelText}>CANCEL</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}
const sw = StyleSheet.create({
  backdrop:   { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet:      { backgroundColor: '#161616', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, paddingBottom: 48 },
  title:      { color: Colors.textPrimary, fontSize: 13, fontWeight: '800', letterSpacing: 2, marginBottom: 4 },
  sub:        { color: Colors.textSecondary, fontSize: 13, marginBottom: 20 },
  row:        { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#222' },
  optLabel:   { color: Colors.textPrimary, fontSize: 15, fontWeight: '600' },
  optNote:    { color: Colors.textSecondary, fontSize: 13, marginTop: 2 },
  cancel:     { marginTop: 20, alignItems: 'center' },
  cancelText: { color: Colors.textSecondary, fontSize: 13, fontWeight: '700', letterSpacing: 1 },
});

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function LiveWorkoutScreen() {
  const navigation = useNavigation<Nav>();
  const route      = useRoute<Route>();
  const { sessionJson, programId, weekNumber, dayName } = route.params;
  const session: ProgramSession = JSON.parse(sessionJson);

  useKeepAwake();

  const steps      = useRef(buildSteps(session)).current;
  const totalSteps = steps.length;

  const [stepIdx,     setStepIdx]     = useState(0);
  const [phase,       setPhase]       = useState<'active' | 'rest' | 'transition' | 'complete'>('active');
  const [restSecs,    setRestSecs]    = useState(60);
  const [restLabel,   setRestLabel]   = useState('Rest');
  const [transFrom,   setTransFrom]   = useState('');
  const [transTo,     setTransTo]     = useState('');
  const [transSecs,   setTransSecs]   = useState(90);
  const [weightInput, setWeightInput] = useState('');
  const [repsInput,   setRepsInput]   = useState('');
  const [loggedSets,  setLoggedSets]  = useState<LoggedSet[]>([]);
  const [elapsed,     setElapsed]     = useState(0);
  const [rpe,         setRpe]         = useState(7);
  const [saving,      setSaving]      = useState(false);
  const [swapVisible, setSwapVisible] = useState(false);
  const [swapLabel,   setSwapLabel]   = useState<string | null>(null);
  const [userId,      setUserId]      = useState<string | null>(null);

  // Metcon state
  const [metconRounds,   setMetconRounds]   = useState(0);
  const [metconElapsed,  setMetconElapsed]  = useState(0);
  const [metconRunning,  setMetconRunning]  = useState(false);
  const [metconComplete, setMetconComplete] = useState(false);
  const metconTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Z2 cardio state
  const [z2Elapsed, setZ2Elapsed] = useState(0);
  const z2TimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const afterRest = useRef<() => void>(() => {});

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  // Global elapsed timer
  useEffect(() => {
    const id = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Back-button confirmation
  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', e => {
      if (phase === 'complete') return;
      e.preventDefault();
      Alert.alert(
        'Exit workout?',
        'Your logged sets will be saved.',
        [
          { text: 'Stay', style: 'cancel' },
          {
            text: 'Exit & Save',
            onPress: async () => {
              await saveSession(false);
              navigation.dispatch(e.data.action);
            },
          },
        ],
      );
    });
    return unsub;
  }, [navigation, phase, loggedSets, elapsed, rpe]); // eslint-disable-line react-hooks/exhaustive-deps

  // Start metcon timer when metcon step is reached
  useEffect(() => {
    const cur = steps[stepIdx];
    if (cur?.kind === 'metcon' && !metconRunning && !metconComplete) {
      setMetconElapsed(0);
      setMetconRounds(0);
      setMetconRunning(true);
    }
  }, [stepIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (metconRunning) {
      metconTimerRef.current = setInterval(() => setMetconElapsed(e => e + 1), 1000);
    } else {
      if (metconTimerRef.current) clearInterval(metconTimerRef.current);
    }
    return () => { if (metconTimerRef.current) clearInterval(metconTimerRef.current); };
  }, [metconRunning]);

  // Z2 timer
  useEffect(() => {
    const cur = steps[stepIdx];
    if (cur?.kind === 'z2_cardio') {
      z2TimerRef.current = setInterval(() => setZ2Elapsed(e => e + 1), 1000);
    } else {
      if (z2TimerRef.current) { clearInterval(z2TimerRef.current); z2TimerRef.current = null; }
    }
    return () => { if (z2TimerRef.current) clearInterval(z2TimerRef.current); };
  }, [stepIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  function advance() {
    const next = stepIdx + 1;
    if (next >= totalSteps) { setPhase('complete'); }
    else {
      const nextStep = steps[next];
      setStepIdx(next);
      setWeightInput('');
      setRepsInput('');
      if (nextStep?.kind === 'rest') {
        const s = nextStep as Extract<Step, { kind: 'rest' }>;
        setRestSecs(s.seconds);
        setRestLabel(s.label);
        setPhase('rest');
        afterRest.current = () => {
          const afterIdx = next + 1;
          if (afterIdx >= totalSteps) { setPhase('complete'); }
          else { setStepIdx(afterIdx); setPhase('active'); }
        };
      } else if (nextStep?.kind === 'transition') {
        const s = nextStep as Extract<Step, { kind: 'transition' }>;
        setTransFrom(s.from); setTransTo(s.to); setTransSecs(s.seconds);
        setPhase('transition');
        afterRest.current = () => {
          const afterIdx = next + 1;
          if (afterIdx >= totalSteps) { setPhase('complete'); }
          else { setStepIdx(afterIdx); setPhase('active'); }
        };
      } else {
        setPhase('active');
      }
    }
  }

  function triggerRest(secs: number, label: string) {
    setRestSecs(secs);
    setRestLabel(label);
    setPhase('rest');
    afterRest.current = () => {
      const next = stepIdx + 1;
      if (next >= totalSteps) { setPhase('complete'); }
      else { setStepIdx(next); setPhase('active'); setWeightInput(''); setRepsInput(''); }
    };
  }

  const onRestDone = useCallback(() => {
    afterRest.current();
  }, []);

  function logSet(step: Extract<Step, { kind: 'strength' }>) {
    const newSet: LoggedSet = {
      exerciseName: step.exercise.name,
      set:          step.setNum,
      weight:       weightInput,
      reps:         repsInput || String(step.exercise.reps ?? ''),
    };
    setLoggedSets(prev => [...prev, newSet]);
    const restS = parseRestSeconds(step.exercise.rest, step.totalSets > 3 ? 180 : 90);
    triggerRest(restS, step.exercise.rest ?? `${restS}s rest`);
  }

  async function saveSession(full: boolean) {
    if (!userId) return;
    setSaving(true);
    try {
      await supabase.from('session_logs').insert({
        user_id:      userId,
        program_id:   programId,
        day_name:     dayName,
        week_number:  weekNumber,
        session_name: session.name,
        log_field:    'live_workout',
        log_value:    `${Math.round(elapsed / 60)} min`,
        weights_used: loggedSets.length > 0 ? JSON.stringify(loggedSets) : null,
        rpe_logged:   full ? rpe : null,
        completed:    full,
        completed_at: new Date().toISOString(),
      });
    } catch (e) {
      console.log('[live-workout] save error:', e);
    }
    setSaving(false);
  }

  function confirmDiscard() {
    Alert.alert(
      'Discard this workout?',
      '',
      [
        { text: 'Keep Going', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: () => navigation.goBack() },
      ],
    );
  }

  async function saveAndExit() {
    await saveSession(true);
    navigation.goBack();
  }

  // ── COMPLETE ─────────────────────────────────────────────────────────────────

  if (phase === 'complete') {
    return (
      <SafeAreaView style={s.container}>
        <StatusBar barStyle="light-content" />
        <ProgressBar done={totalSteps} total={totalSteps} />
        <ScrollView contentContainerStyle={s.centerPad}>
          <Text style={s.completeTitle}>SESSION{'\n'}COMPLETE.</Text>
          <Text style={s.completeSub}>{session.name}</Text>
          <View style={s.statRow}>
            <View style={s.stat}><Text style={s.statVal}>{formatTime(elapsed)}</Text><Text style={s.statLbl}>ELAPSED</Text></View>
            <View style={s.stat}><Text style={s.statVal}>{loggedSets.length}</Text><Text style={s.statLbl}>SETS LOGGED</Text></View>
          </View>
          <Text style={s.rpeLabel}>HOW HARD WAS IT?</Text>
          <View style={s.rpeRow}>
            {[1,2,3,4,5,6,7,8,9,10].map(n => (
              <TouchableOpacity key={n} style={[s.rpeDot, rpe===n && s.rpeDotOn]} onPress={() => setRpe(n)}>
                <Text style={[s.rpeTxt, rpe===n && s.rpeTxtOn]}>{n}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={s.rpeDesc}>
            {rpe<=3?'Easy — well within limits':rpe<=5?'Moderate — controlled effort':rpe<=7?'Hard — challenged but in control':rpe<=9?'Very hard — near limit':'Max effort'}
          </Text>
          <TouchableOpacity style={[s.primaryBtn, saving && s.btnOff]} onPress={saveAndExit} disabled={saving}>
            <Text style={s.primaryBtnTxt}>{saving ? 'SAVING...' : 'SAVE & EXIT'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={{ marginTop: 16, alignItems: 'center' }} onPress={confirmDiscard}>
            <Text style={{ color: Colors.textSecondary, fontSize: 13 }}>Discard workout</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── REST ──────────────────────────────────────────────────────────────────────

  if (phase === 'rest') {
    return (
      <SafeAreaView style={s.container}>
        <StatusBar barStyle="light-content" />
        <ProgressBar done={stepIdx} total={totalSteps} />
        <RestCountdown seconds={restSecs} label={restLabel} onSkip={onRestDone} />
      </SafeAreaView>
    );
  }

  // ── TRANSITION ────────────────────────────────────────────────────────────────

  if (phase === 'transition') {
    return (
      <SafeAreaView style={s.container}>
        <StatusBar barStyle="light-content" />
        <ProgressBar done={stepIdx} total={totalSteps} />
        <View style={s.transContainer}>
          <Text style={s.transTag}>{transFrom.toUpperCase()} COMPLETE</Text>
          <Text style={s.transTitle}>{transFrom} Complete.</Text>
          <Text style={s.transSub}>
            Take a moment to transition.{'\n'}
            {transTo === 'Strength' ? 'Set up your equipment, grab water, reset.' : 'Shake out, get your pace target ready.'}
          </Text>
          <TransitionTimer seconds={transSecs} onDone={onRestDone} />
        </View>
      </SafeAreaView>
    );
  }

  // ── ACTIVE ────────────────────────────────────────────────────────────────────

  const currentStep = steps[stepIdx];
  if (!currentStep) return null;

  return (
    <SafeAreaView style={s.container}>
      <StatusBar barStyle="light-content" />
      <ProgressBar done={stepIdx} total={totalSteps} />
      <TouchableOpacity
        style={{ position: 'absolute', top: 16, left: 16, zIndex: 10, padding: 8 }}
        onPress={confirmDiscard}
      >
        <Feather name="x" color={Colors.textSecondary} size={22} />
      </TouchableOpacity>

      {currentStep.kind === 'z2_cardio' && (
        <Z2Phase
          step={currentStep}
          elapsed={z2Elapsed}
          onEnd={() => advance()}
        />
      )}

      {currentStep.kind === 'metcon' && (
        <MetconPhase
          step={currentStep}
          elapsed={metconElapsed}
          rounds={metconRounds}
          running={metconRunning}
          onAddRound={() => setMetconRounds(r => r + 1)}
          onFinish={() => { setMetconRunning(false); setMetconComplete(true); advance(); }}
        />
      )}

      {(currentStep.kind === 'generic') && (
        <GenericPhase
          step={currentStep}
          elapsed={elapsed}
          isLast={stepIdx === totalSteps - 1}
          onDone={advance}
        />
      )}

      {currentStep.kind === 'run_interval' && (
        <RunIntervalPhase
          step={currentStep}
          elapsed={elapsed}
          swapLabel={swapLabel}
          isLast={stepIdx === totalSteps - 1}
          onDone={advance}
          onOpenSwap={() => setSwapVisible(true)}
        />
      )}

      {currentStep.kind === 'strength' && (
        <StrengthPhase
          step={currentStep}
          elapsed={elapsed}
          weightInput={weightInput}
          repsInput={repsInput}
          prevSets={loggedSets.filter(l => l.exerciseName === currentStep.exercise.name)}
          onWeightChange={setWeightInput}
          onRepsChange={setRepsInput}
          onLogSet={() => logSet(currentStep)}
        />
      )}

      <SwapSheet
        visible={swapVisible}
        onClose={() => setSwapVisible(false)}
        onSelect={setSwapLabel}
      />
    </SafeAreaView>
  );
}

// ─── TransitionTimer (shows countdown + "Start [X]" button) ──────────────────

function TransitionTimer({ seconds, onDone }: { seconds: number; onDone: () => void }) {
  const [rem, setRem] = useState(seconds);
  const [canStart, setCanStart] = useState(false);
  useEffect(() => {
    if (rem <= 0) { setCanStart(true); return; }
    if (seconds - rem >= 30) setCanStart(true);
    const id = setTimeout(() => setRem(r => r - 1), 1000);
    return () => clearTimeout(id);
  }, [rem, seconds]);
  return (
    <View style={{ alignItems: 'center', marginTop: 32 }}>
      <Text style={{ color: Colors.accent, fontSize: 48, fontFamily: Fonts.metricHeavy, fontVariant: ['tabular-nums' as const] }}>
        {formatTime(rem)}
      </Text>
      {canStart && (
        <TouchableOpacity style={[s.primaryBtn, { marginTop: 24, paddingHorizontal: 40 }]} onPress={onDone}>
          <Text style={s.primaryBtnTxt}>CONTINUE →</Text>
        </TouchableOpacity>
      )}
      {!canStart && (
        <TouchableOpacity style={{ marginTop: 24 }} onPress={onDone}>
          <Text style={{ color: Colors.textSecondary, fontSize: 13 }}>Skip transition</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ─── Z2 Phase ─────────────────────────────────────────────────────────────────

function Z2Phase({
  step, elapsed, onEnd,
}: {
  step: Extract<Step, { kind: 'z2_cardio' }>;
  elapsed: number;
  onEnd: () => void;
}) {
  const paceTarget = step.session.description?.match(/Target:\s*[\d:]+\/k[m]?/i)?.[0] ?? null;
  return (
    <View style={z2.container}>
      <Text style={z2.sessionName}>{step.session.name}</Text>
      {!!step.session.description && (
        <Text style={z2.desc}>{step.session.description}</Text>
      )}
      {paceTarget && <Text style={z2.pace}>{paceTarget}</Text>}
      <Text style={z2.timer}>{formatTime(elapsed)}</Text>
      <Text style={z2.timerLabel}>ELAPSED</Text>
      <TouchableOpacity style={[s.primaryBtn, { marginTop: 48 }]} onPress={onEnd}>
        <Text style={s.primaryBtnTxt}>END SESSION →</Text>
      </TouchableOpacity>
    </View>
  );
}
const z2 = StyleSheet.create({
  container:   { flex: 1, padding: 28, justifyContent: 'center' },
  sessionName: { color: Colors.textSecondary, fontSize: 12, fontWeight: '700', letterSpacing: 2, marginBottom: 12 },
  desc:        { color: Colors.textPrimary, fontSize: 16, lineHeight: 22, marginBottom: 20 },
  pace:        { color: Colors.accent, fontSize: 18, fontWeight: '700', marginBottom: 32 },
  timer:       { color: Colors.textPrimary, fontSize: 72, fontFamily: Fonts.metricHeavy, fontVariant: ['tabular-nums' as const], textAlign: 'center' },
  timerLabel:  { color: Colors.textSecondary, fontSize: 12, fontWeight: '700', letterSpacing: 2, textAlign: 'center' },
});

// ─── Metcon Phase ─────────────────────────────────────────────────────────────

function MetconPhase({
  step, elapsed, rounds, running, onAddRound, onFinish,
}: {
  step: Extract<Step, { kind: 'metcon' }>;
  elapsed: number;
  rounds: number;
  running: boolean;
  onAddRound: () => void;
  onFinish: () => void;
}) {
  const format   = step.format.toUpperCase();
  const timeLeft = Math.max(0, step.timeCap - elapsed);
  const isAMRAP  = step.format === 'amrap';
  const isEMOM   = step.format === 'emom';

  return (
    <ScrollView contentContainerStyle={mc.container}>
      <Text style={mc.format}>{format}</Text>
      <Text style={mc.timer}>{isAMRAP ? formatTime(elapsed) : isEMOM ? formatTime(timeLeft) : `${rounds} RDS`}</Text>
      {(isAMRAP || isEMOM) && (
        <Text style={mc.timeCap}>
          {isAMRAP ? `Cap: ${Math.round(step.timeCap / 60)} min` : `${Math.round(timeLeft / 60)} min left`}
        </Text>
      )}

      <View style={mc.movList}>
        {(step.block.exercises ?? []).map((ex, i) => (
          <View key={i} style={mc.movRow}>
            <Text style={mc.movName}>{ex.name}</Text>
            {!!ex.reps && <Text style={mc.movReps}>{ex.reps}</Text>}
            {!!(ex.notes || ex.note) && <Text style={mc.movNote}>{ex.notes || ex.note}</Text>}
          </View>
        ))}
      </View>

      <TouchableOpacity style={mc.roundBtn} onPress={onAddRound}>
        <Text style={mc.roundBtnTxt}>+ ROUND  {rounds}</Text>
      </TouchableOpacity>

      <TouchableOpacity style={[s.primaryBtn, { marginTop: 20 }]} onPress={onFinish}>
        <Text style={s.primaryBtnTxt}>FINISH METCON →</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}
const mc = StyleSheet.create({
  container: { padding: 24, paddingBottom: 60 },
  format:    { color: Colors.textSecondary, fontSize: 13, fontWeight: '700', letterSpacing: 2, marginBottom: 8 },
  timer:     { color: Colors.accent, fontSize: 72, fontFamily: Fonts.metricHeavy, fontVariant: ['tabular-nums' as const] },
  timeCap:   { color: Colors.textSecondary, fontSize: 14, marginBottom: 24 },
  movList:   { gap: 12, marginBottom: 28, marginTop: 12 },
  movRow:    { borderLeftWidth: 3, borderLeftColor: Colors.accent, paddingLeft: 12, gap: 2 },
  movName:   { color: Colors.textPrimary, fontSize: 16, fontWeight: '600' },
  movReps:   { color: Colors.accent, fontSize: 14, fontWeight: '700' },
  movNote:   { color: Colors.textSecondary, fontSize: 13 },
  roundBtn:  { backgroundColor: Colors.card, borderRadius: 14, padding: 20, alignItems: 'center', borderWidth: 2, borderColor: Colors.accent },
  roundBtnTxt: { color: Colors.accent, fontSize: 18, fontWeight: '800', letterSpacing: 1 },
});

// ─── Generic Phase (warm-up / cool-down) ─────────────────────────────────────

function GenericPhase({
  step, elapsed, isLast, onDone,
}: {
  step: Extract<Step, { kind: 'generic' }>;
  elapsed: number;
  isLast: boolean;
  onDone: () => void;
}) {
  const ex = step.exercise;
  const detail = ex.sets && ex.reps ? `${ex.sets} × ${ex.reps}` : (ex.reps ?? '');
  return (
    <View style={gp.container}>
      <View style={gp.header}>
        <Text style={gp.blockLabel}>{step.blockName.toUpperCase()}</Text>
        <Text style={gp.elapsed}>{formatTime(elapsed)}</Text>
      </View>
      <Text style={gp.name}>{ex.name}</Text>
      {!!detail && <Text style={gp.detail}>{detail}</Text>}
      {!!(ex.notes || ex.note) && <Text style={gp.note}>{ex.notes || ex.note}</Text>}
      <TouchableOpacity style={[s.primaryBtn, gp.btn]} onPress={onDone}>
        <Text style={s.primaryBtnTxt}>{isLast ? 'FINISH' : 'DONE →'}</Text>
      </TouchableOpacity>
    </View>
  );
}
const gp = StyleSheet.create({
  container:  { flex: 1, padding: 28, justifyContent: 'center' },
  header:     { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 28 },
  blockLabel: { color: Colors.textSecondary, fontSize: 11, fontWeight: '700', letterSpacing: 2 },
  elapsed:    { color: Colors.textSecondary, fontSize: 13, fontVariant: ['tabular-nums' as const] },
  name:       { color: Colors.textPrimary, fontSize: 34, fontWeight: '800', lineHeight: 40, marginBottom: 10 },
  detail:     { color: Colors.textSecondary, fontSize: 16, marginBottom: 8 },
  note:       { color: Colors.textSecondary, fontSize: 14, lineHeight: 20, marginBottom: 24 },
  btn:        { marginTop: 40 },
});

// ─── Run Interval Phase ───────────────────────────────────────────────────────

function RunIntervalPhase({
  step, elapsed, swapLabel, isLast, onDone, onOpenSwap,
}: {
  step: Extract<Step, { kind: 'run_interval' }>;
  elapsed: number;
  swapLabel: string | null;
  isLast: boolean;
  onDone: () => void;
  onOpenSwap: () => void;
}) {
  const ex         = step.exercise;
  const paceTarget = extractPaceTarget(ex);
  const displayName = swapLabel
    ? ex.name.replace(/run|running/gi, swapLabel)
    : ex.name;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={rp.container}>
        <View style={rp.header}>
          <Text style={rp.blockLabel}>{step.blockName.toUpperCase()} · INTERVAL {step.intervalNum} OF {step.totalIntervals}</Text>
          <Text style={rp.elapsed}>{formatTime(elapsed)}</Text>
        </View>

        <Text style={rp.name}>{displayName}</Text>
        <Text style={rp.distance}>{ex.reps ?? ''}</Text>

        {paceTarget ? (
          <Text style={rp.pace}>{paceTarget}</Text>
        ) : null}

        {!!(ex.notes || ex.note) && (
          <Text style={rp.note}>{ex.notes || ex.note}</Text>
        )}

        <TouchableOpacity style={rp.swapBtn} onPress={onOpenSwap}>
          <Text style={rp.swapTxt}>SWAP RUN →</Text>
        </TouchableOpacity>

        <TouchableOpacity style={[s.primaryBtn, { marginTop: 32 }]} onPress={onDone}>
          <Text style={s.primaryBtnTxt}>{isLast ? 'FINISH' : step.intervalNum === step.totalIntervals ? 'DONE →' : `NEXT INTERVAL →`}</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
const rp = StyleSheet.create({
  container:  { padding: 28, paddingBottom: 60, flexGrow: 1 },
  header:     { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 28 },
  blockLabel: { color: Colors.textSecondary, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, flex: 1 },
  elapsed:    { color: Colors.textSecondary, fontSize: 13, fontVariant: ['tabular-nums' as const] },
  name:       { color: Colors.textPrimary, fontSize: 32, fontWeight: '800', lineHeight: 38, marginBottom: 6 },
  distance:   { color: Colors.textSecondary, fontSize: 18, marginBottom: 16 },
  pace:       { color: Colors.accent, fontSize: 28, fontFamily: Fonts.metric, marginBottom: 8 },
  note:       { color: Colors.textSecondary, fontSize: 14, lineHeight: 20, marginBottom: 12 },
  swapBtn:    { marginTop: 4 },
  swapTxt:    { color: Colors.textSecondary, fontSize: 12, fontWeight: '700', letterSpacing: 1 },
});

// ─── Strength Phase ───────────────────────────────────────────────────────────

function StrengthPhase({
  step, elapsed, weightInput, repsInput, prevSets, onWeightChange, onRepsChange, onLogSet,
}: {
  step: Extract<Step, { kind: 'strength' }>;
  elapsed: number;
  weightInput: string;
  repsInput: string;
  prevSets: LoggedSet[];
  onWeightChange: (v: string) => void;
  onRepsChange: (v: string) => void;
  onLogSet: () => void;
}) {
  const ex         = step.exercise;
  const numReps    = String(ex.reps ?? '').match(/\d+/)?.[0] ?? '';
  const lastWeight = prevSets.length > 0 ? prevSets[prevSets.length - 1].weight : null;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={sp.container} keyboardShouldPersistTaps="handled">
        <View style={sp.header}>
          <Text style={sp.blockLabel}>{step.blockName.toUpperCase()}</Text>
          <Text style={sp.elapsed}>{formatTime(elapsed)}</Text>
        </View>

        <Text style={sp.setCounter}>SET {step.setNum} OF {step.totalSets}</Text>
        <Text style={sp.name}>{ex.name}</Text>
        <Text style={sp.prescribed}>{ex.sets} × {ex.reps}{ex.rest ? ` · ${ex.rest} rest` : ''}</Text>
        {!!(ex.notes || ex.note) && <Text style={sp.note}>{ex.notes || ex.note}</Text>}

        {lastWeight && <Text style={sp.lastWeight}>Last set: {lastWeight} lbs</Text>}

        <View style={sp.inputRow}>
          <View style={sp.inputGroup}>
            <Text style={sp.inputLabel}>REPS</Text>
            <TextInput
              style={sp.input}
              value={repsInput}
              onChangeText={onRepsChange}
              placeholder={numReps || '—'}
              placeholderTextColor={Colors.textSecondary}
              keyboardType="number-pad"
              selectionColor={Colors.accent}
            />
          </View>
          <View style={sp.inputGroup}>
            <Text style={sp.inputLabel}>WEIGHT (LBS)</Text>
            <TextInput
              style={sp.input}
              value={weightInput}
              onChangeText={onWeightChange}
              placeholder={lastWeight ?? '0'}
              placeholderTextColor={Colors.textSecondary}
              keyboardType="decimal-pad"
              selectionColor={Colors.accent}
            />
          </View>
        </View>

        <TouchableOpacity style={[s.primaryBtn, { marginTop: 4 }]} onPress={onLogSet}>
          <Text style={s.primaryBtnTxt}>LOG SET {step.setNum}</Text>
        </TouchableOpacity>

        {prevSets.length > 0 && (
          <View style={sp.prevSets}>
            {prevSets.map((ls, i) => (
              <Text key={i} style={sp.prevRow}>Set {ls.set} · {ls.reps} reps · {ls.weight} lbs</Text>
            ))}
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
const sp = StyleSheet.create({
  container:   { padding: 28, paddingBottom: 60, flexGrow: 1 },
  header:      { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 },
  blockLabel:  { color: Colors.textSecondary, fontSize: 11, fontWeight: '700', letterSpacing: 2 },
  elapsed:     { color: Colors.textSecondary, fontSize: 13, fontVariant: ['tabular-nums' as const] },
  setCounter:  { color: Colors.textSecondary, fontSize: 12, fontWeight: '700', letterSpacing: 2, marginBottom: 8 },
  name:        { color: Colors.textPrimary, fontSize: 28, fontWeight: '800', lineHeight: 32, marginBottom: 4 },
  prescribed:  { color: Colors.textSecondary, fontSize: 14, marginBottom: 4 },
  note:        { color: Colors.textSecondary, fontSize: 13, lineHeight: 18, marginBottom: 8 },
  lastWeight:  { color: Colors.textSecondary, fontSize: 13, marginBottom: 20 },
  inputRow:    { flexDirection: 'row', gap: 16, marginBottom: 20 },
  inputGroup:  { flex: 1, gap: 6 },
  inputLabel:  { color: Colors.textSecondary, fontSize: 11, fontWeight: '700', letterSpacing: 1.5 },
  input: {
    backgroundColor: Colors.nested, borderRadius: 10, padding: 14,
    color: Colors.textPrimary, fontSize: 28, fontFamily: Fonts.metric, textAlign: 'center',
    borderWidth: 1, borderColor: '#2a2a2a',
  },
  prevSets: { marginTop: 24, gap: 4 },
  prevRow:  { color: '#444', fontSize: 13 },
});

// ─── Shared styles ────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: Colors.background },
  centerPad:    { padding: 24, paddingBottom: 60, flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  transContainer: { flex: 1, padding: 28, justifyContent: 'center', alignItems: 'center' },
  transTag:     { color: Colors.accent, fontSize: 11, fontWeight: '800', letterSpacing: 2, marginBottom: 16 },
  transTitle:   { color: Colors.textPrimary, fontSize: 40, fontWeight: '900', textAlign: 'center' },
  transSub:     { color: Colors.textSecondary, fontSize: 15, textAlign: 'center', marginTop: 12, lineHeight: 22 },

  primaryBtn:    { backgroundColor: Colors.accent, borderRadius: 14, padding: 18, alignItems: 'center', width: '100%' },
  btnOff:        { opacity: 0.5 },
  primaryBtnTxt: { color: Colors.background, fontSize: 14, fontWeight: '800', letterSpacing: 1.5 },

  completeTitle:   { color: Colors.textPrimary, fontSize: 48, fontFamily: Fonts.metricHeavy, lineHeight: 52, textAlign: 'center', marginBottom: 8 },
  completeSub:     { color: Colors.textSecondary, fontSize: 14, marginBottom: 40, textAlign: 'center' },
  statRow:  { flexDirection: 'row', gap: 40, marginBottom: 48 },
  stat:     { alignItems: 'center', gap: 4 },
  statVal:  { color: Colors.accent, fontSize: 36, fontFamily: Fonts.metric },
  statLbl:  { color: Colors.textSecondary, fontSize: 11, fontWeight: '700', letterSpacing: 1.5 },

  rpeLabel: { color: Colors.textSecondary, fontSize: 11, fontWeight: '700', letterSpacing: 2, marginBottom: 16 },
  rpeRow:   { flexDirection: 'row', gap: 6, marginBottom: 12, flexWrap: 'wrap', justifyContent: 'center' },
  rpeDot:   { width: 36, height: 36, borderRadius: 18, backgroundColor: Colors.nested, alignItems: 'center', justifyContent: 'center' },
  rpeDotOn: { backgroundColor: Colors.accent },
  rpeTxt:   { color: Colors.textSecondary, fontSize: 14, fontWeight: '700' },
  rpeTxtOn: { color: Colors.background },
  rpeDesc:  { color: Colors.textSecondary, fontSize: 13, textAlign: 'center', marginBottom: 40 },
});
