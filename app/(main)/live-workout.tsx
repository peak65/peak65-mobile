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
  Platform, StatusBar, ActivityIndicator, AppState, Animated,
} from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Haptics from 'expo-haptics';
import * as Speech from 'expo-speech';
import { Audio } from 'expo-av';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MainStackParamList, ProgramSession, SessionBlock, ExerciseItem } from '../_layout';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../../lib/supabase';
import { Feather } from '@expo/vector-icons';
import { Colors, Fonts } from '../../lib/theme';
import Tooltip from '../components/Tooltip';
import { startLiveActivity as laStart, updateLiveActivity as laUpdate, endLiveActivity as laEnd } from '../../modules/live-activity';

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

function announceSpeech(text: string): void {
  try {
    Speech.stop();
    Speech.speak(text, { rate: 0.9 });
  } catch {}
}

function buildSpeechAnnouncement(step: Step): string | null {
  switch (step.kind) {
    case 'run_interval': {
      const pace = extractPaceTarget(step.exercise);
      let text = `Interval ${step.intervalNum} of ${step.totalIntervals}. ${step.exercise.reps ?? ''}`;
      if (pace) text += `. Target pace: ${pace}`;
      return text;
    }
    case 'metcon':
      return `${step.format.toUpperCase()}. ${step.block.block_name}`;
    case 'z2_cardio':
      return `Zone 2 cardio. ${step.session.name}`;
    case 'generic': {
      const dur = parseDurationSecs(String(step.exercise.reps ?? ''));
      if (!dur) return null;
      return `${step.exercise.name}. ${step.exercise.reps}`;
    }
    default:
      return null;
  }
}

const BODYWEIGHT_NAMES = [
  'burpee', 'push-up', 'push up', 'pushup', 'pull-up', 'pull up', 'pullup',
  'chin-up', 'chin up', 'chinup', 'lunge', 'squat', 'sit-up', 'sit up', 'situp',
  'plank', 'hollow hold', 'hollow body', 'mountain climber', 'box jump',
  'dip', 'ring dip', 'jumping jack', 'bear crawl', 'inchworm', 'walkout',
  'v-up', 'v up', 'glute bridge', 'hip thrust', 'air squat', 'tuck jump',
  'broad jump', 'step-up', 'step up', 'calf raise', 'jump squat',
];

function isBodyweightExercise(name: string): boolean {
  const lower = name.toLowerCase();
  return BODYWEIGHT_NAMES.some(bw => lower.includes(bw));
}

function parseDurationSecs(reps: string | undefined): number | null {
  if (!reps) return null;
  const s = reps.toLowerCase().trim();
  if (/^\d+\.?\d*$/.test(s)) return parseFloat(s);
  const colon = s.match(/^(\d+):(\d+)$/);
  if (colon) return parseInt(colon[1]) * 60 + parseInt(colon[2]);
  const rangeMins = s.match(/^(\d+)\s*[-–]\s*\d+\s*min/);
  if (rangeMins) return parseInt(rangeMins[1]) * 60;
  const mins = s.match(/(\d+)\s*min/);
  const secs = s.match(/(\d+)\s*s(?:ec)?/);
  if (!mins && !secs) return null;
  let t = 0;
  if (mins) t += parseInt(mins[1]) * 60;
  if (secs) t += parseInt(secs[1]);
  return t > 0 ? t : null;
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

function isDistanceBasedExercise(name: string): boolean {
  const lower = name.toLowerCase();
  return ['sled push', 'sled pull', 'burpee broad jump', 'farmers carry', 'sandbag lunge', 'ski erg', 'row erg', 'wall ball']
    .some(term => lower.includes(term));
}

function isWarmupStep(step: Step): boolean {
  if (step.kind === 'generic') return /warm/i.test(step.blockName);
  return false;
}

function isCooldownStep(step: Step): boolean {
  if (step.kind === 'generic') return /cool/i.test(step.blockName);
  return false;
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

    const strengthExes = exercises.filter(e => isStrengthExercise(e, block.block_name));
    const hasCircuitId = exercises.some(e => e.circuit_id != null);
    const hasSupersetId = exercises.some(e => e.superset_id != null);
    const isCircuit = hasCircuitId || hasSupersetId || (/circuit|superset|complex/i.test(block.block_name) && strengthExes.length > 1);

    if (isCircuit) {
      if (blockHadRun || prevKind === 'run') {
        steps.push({ kind: 'transition', from: 'Run', to: 'Strength', seconds: 90 });
      }

      // Group exercises by circuit_id or superset_id
      // Exercises sharing the same id go together and interleave rounds
      // Exercises with no id are solo — treated as their own group
      const groups: ExerciseItem[][] = [];
      const seen = new Map<string, ExerciseItem[]>();

      for (const ex of exercises) {
        const groupKey = ex.circuit_id ?? ex.superset_id ?? null;
        if (groupKey) {
          if (!seen.has(groupKey)) {
            const g: ExerciseItem[] = [];
            seen.set(groupKey, g);
            groups.push(g);
          }
          seen.get(groupKey)!.push(ex);
        } else {
          groups.push([ex]);
        }
      }

      // For each group, run rounds interleaved — all exercises in the group
      // complete before rest fires. Solo exercises rest after each set.
      for (const group of groups) {
        const rounds = Math.max(...group.map(e => e.sets ?? 1));
        const restLabel = group.length > 1 ? 'Circuit rest' : (group[0]?.rest ?? 'Rest');
        const restSecs = parseRestSeconds(
          group[0]?.circuit_rest ?? group[0]?.rest,
          group.length > 1 ? 60 : 90
        );
        for (let round = 0; round < rounds; round++) {
          for (const ex of group) {
            if (round < (ex.sets ?? 1)) {
              steps.push({ kind: 'strength', exercise: ex, setNum: round + 1, totalSets: ex.sets ?? 1, blockName: block.block_name });
            }
          }
          if (round < rounds - 1) {
            steps.push({ kind: 'rest', seconds: restSecs, label: restLabel });
          }
        }
      }

      blockHadStrength = true;
    } else {
      for (const ex of exercises) {
        if (isRunExercise(ex)) {
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
          steps.push({ kind: 'generic', exercise: ex, blockName: block.block_name });
        }
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

// ─── Live Activity helpers ────────────────────────────────────────────────────

function laGetExerciseName(step: Step): string {
  if ('exercise' in step) return (step as any).exercise.name;
  if (step.kind === 'rest') return 'REST';
  if (step.kind === 'transition') return `${step.from} → ${step.to}`;
  if (step.kind === 'metcon') return step.block.block_name;
  if (step.kind === 'z2_cardio') return step.session.name;
  return '';
}

function laGetTargetDisplay(step: Step): string {
  if ('exercise' in step) return String((step as any).exercise.reps ?? '');
  if (step.kind === 'rest') {
    const m = Math.floor(step.seconds / 60);
    const s = step.seconds % 60;
    return m > 0 ? `${m}:${String(s).padStart(2, '0')} rest` : `${s}s rest`;
  }
  return '';
}

function laGetPace(step: Step): string {
  if ('exercise' in step) return extractPaceTarget((step as any).exercise) ?? '';
  return '';
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function LiveWorkoutScreen() {
  const navigation = useNavigation<Nav>();
  const route      = useRoute<Route>();
  const insets     = useSafeAreaInsets();
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
  const [savedLogId,  setSavedLogId]  = useState<string | null>(null);
  const [hrZoneStep,  setHrZoneStep]  = useState<'none' | 'prompt' | 'uploading' | 'done'>('none');

  // Metcon state
  const [metconRounds,      setMetconRounds]      = useState(0);
  const [metconElapsed,     setMetconElapsed]     = useState(0);
  const [metconRunning,     setMetconRunning]     = useState(false);
  const [metconComplete,    setMetconComplete]    = useState(false);
  const [metconFinalRounds, setMetconFinalRounds] = useState(0);
  const metconTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Z2 cardio state
  const [z2Elapsed, setZ2Elapsed] = useState(0);
  const z2TimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const afterRest = useRef<() => void>(() => {});

  // Background timer tracking (FIX 3)
  const startTimeRef          = useRef(0);
  const currentTimerDuration  = useRef(0);
  const nextExerciseNameRef   = useRef('');
  const phaseRef              = useRef<'active' | 'rest' | 'transition' | 'complete'>('active');
  const onRestDoneRef         = useRef<() => void>(() => {});

  // Live Activity per-second refs
  const elapsedRef            = useRef(0);
  const stepStartElapsed      = useRef(0);
  const currentStepDuration   = useRef(0);
  const laStepNameRef         = useRef('');
  const laStepTargetRef       = useRef('');
  const laNextNameRef         = useRef('');
  const laNextTargetRef       = useRef('');
  const laStepIndexRef        = useRef(0);

  // Per-step elapsed timer for Hyrox tap zone (FIX 5)
  const [stepElapsed, setStepElapsed] = useState(0);

  // Exit modal (FIX 6)
  const [exitModalVisible, setExitModalVisible] = useState(false);

  // Live Activity
  const liveActivityStarted = useRef(false);

  async function startLiveActivity() {
    if (liveActivityStarted.current) return;
    const cur = steps[0];
    const nxt = steps[1];
    const curDur = cur && 'exercise' in cur ? (parseDurationSecs(String((cur as any).exercise?.reps ?? '')) ?? 0) : 0;
    laStepNameRef.current    = cur ? laGetExerciseName(cur) : '';
    laStepTargetRef.current  = cur ? laGetTargetDisplay(cur) : '';
    laNextNameRef.current    = nxt ? laGetExerciseName(nxt) : '';
    laNextTargetRef.current  = nxt ? laGetTargetDisplay(nxt) : '';
    laStepIndexRef.current   = 1;
    currentStepDuration.current = curDur;
    stepStartElapsed.current = 0;
    await laStart(session.name, {
      exerciseName: laStepNameRef.current,
      targetDisplay: laStepTargetRef.current,
      remainingSecs: curDur,
      nextExerciseName: laNextNameRef.current,
      nextTargetDisplay: laNextTargetRef.current,
      elapsedSecs: 0,
      stationIndex: 1,
      totalStations: totalSteps,
      currentPace: cur ? laGetPace(cur) : '',
      isRest: false,
      timerEndDate: curDur > 0 ? Date.now() + curDur * 1000 : undefined,
    });
    liveActivityStarted.current = true;
  }

  function pushLiveActivityUpdate(state: {
    exerciseName: string; targetDisplay: string; remainingSecs: number;
    nextExerciseName: string; nextTargetDisplay: string; elapsedSecs: number;
    stationIndex: number; totalStations: number; currentPace: string; isRest: boolean;
    timerEndDate?: number;
  }) {
    if (!liveActivityStarted.current) return;
    laUpdate(state).catch(() => {});
  }

  function endLiveActivity() {
    if (!liveActivityStarted.current) return;
    laEnd().catch(() => {});
    liveActivityStarted.current = false;
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setUserId(session?.user?.id ?? null));
  }, []);

  // Start Live Activity once userId resolves; end it when workout completes
  useEffect(() => { if (userId) startLiveActivity(); }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (phase === 'complete') endLiveActivity(); }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep phaseRef and onRestDoneRef current for use inside AppState listener
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { onRestDoneRef.current = onRestDone; }, [onRestDone]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-step elapsed counter (resets on each new step)
  useEffect(() => {
    setStepElapsed(0);
    const id = setInterval(() => setStepElapsed(e => e + 1), 1000);
    return () => clearInterval(id);
  }, [stepIdx]);

  // AppState background/foreground handler for timer notifications (FIX 3)
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (nextAppState) => {
      if (nextAppState === 'background' || nextAppState === 'inactive') {
        if (startTimeRef.current > 0 && currentTimerDuration.current > 0) {
          const elapsed = (Date.now() - startTimeRef.current) / 1000;
          const remaining = currentTimerDuration.current - elapsed;
          if (remaining > 0) {
            try {
              await Notifications.scheduleNotificationAsync({
                content: {
                  title: 'Peak 65',
                  body: `Time's up — ${nextExerciseNameRef.current}. Go.`,
                },
                trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: Math.ceil(remaining), repeats: false },
              });
            } catch {}
          }
        }
      } else if (nextAppState === 'active') {
        try { await Notifications.cancelAllScheduledNotificationsAsync(); } catch {}
        if (startTimeRef.current > 0 && currentTimerDuration.current > 0) {
          const elapsed = (Date.now() - startTimeRef.current) / 1000;
          if (elapsed >= currentTimerDuration.current) {
            if (phaseRef.current === 'rest' || phaseRef.current === 'transition') {
              onRestDoneRef.current();
            }
          } else {
            const remaining = Math.max(1, Math.ceil(currentTimerDuration.current - elapsed));
            if (phaseRef.current === 'rest') setRestSecs(remaining);
            else if (phaseRef.current === 'transition') setTransSecs(remaining);
          }
        }
      }
    });
    return () => sub.remove();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Global elapsed timer
  useEffect(() => {
    const id = setInterval(() => setElapsed(e => { elapsedRef.current = e + 1; return e + 1; }), 1000);
    return () => clearInterval(id);
  }, []);

  // Per-second Live Activity update for countdown
  useEffect(() => {
    if (!liveActivityStarted.current) return;
    if (phaseRef.current !== 'active') return;
    const dur = currentStepDuration.current;
    if (dur <= 0) return;
    const stepElapsedSecs = elapsedRef.current - stepStartElapsed.current;
    const remaining = Math.max(0, dur - stepElapsedSecs);
    laUpdate({
      exerciseName: laStepNameRef.current,
      targetDisplay: laStepTargetRef.current,
      remainingSecs: remaining,
      nextExerciseName: laNextNameRef.current,
      nextTargetDisplay: laNextTargetRef.current,
      elapsedSecs: elapsedRef.current,
      stationIndex: laStepIndexRef.current,
      totalStations: totalSteps,
      currentPace: '',
      isRest: false,
      timerEndDate: remaining > 0 ? Date.now() + remaining * 1000 : undefined,
    }).catch(() => {});
  }, [elapsed]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const advance = useCallback(() => {
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
        startTimeRef.current = Date.now();
        currentTimerDuration.current = s.seconds;
        const afterStep = steps[next + 1];
        nextExerciseNameRef.current = afterStep && 'exercise' in afterStep ? (afterStep as any).exercise.name : 'Next exercise';
        const mins = Math.floor(s.seconds / 60);
        const secs = s.seconds % 60;
        const durText = mins > 0 ? `${mins} minute${mins > 1 ? 's' : ''}` : `${secs} seconds`;
        announceSpeech(`Rest. ${durText}.`);
        afterRest.current = () => {
          const afterIdx = next + 1;
          if (afterIdx >= totalSteps) { setPhase('complete'); }
          else {
            const afterStep = steps[afterIdx];
            setStepIdx(afterIdx);
            setPhase('active');
            const speech = buildSpeechAnnouncement(afterStep);
            if (speech) announceSpeech(speech);
          }
        };
        pushLiveActivityUpdate({
          exerciseName: 'REST', targetDisplay: '',
          remainingSecs: s.seconds,
          nextExerciseName: afterStep ? laGetExerciseName(afterStep) : 'Complete',
          nextTargetDisplay: afterStep ? laGetTargetDisplay(afterStep) : '',
          elapsedSecs: elapsed, stationIndex: next + 1, totalStations: totalSteps,
          currentPace: '', isRest: true,
        });
      } else if (nextStep?.kind === 'transition') {
        const s = nextStep as Extract<Step, { kind: 'transition' }>;
        setTransFrom(s.from); setTransTo(s.to); setTransSecs(s.seconds);
        setPhase('transition');
        startTimeRef.current = Date.now();
        currentTimerDuration.current = s.seconds;
        const afterTransStep = steps[next + 1];
        nextExerciseNameRef.current = afterTransStep && 'exercise' in afterTransStep ? (afterTransStep as any).exercise.name : s.to;
        afterRest.current = () => {
          const afterIdx = next + 1;
          if (afterIdx >= totalSteps) { setPhase('complete'); }
          else {
            const afterStep = steps[afterIdx];
            setStepIdx(afterIdx);
            setPhase('active');
            const speech = buildSpeechAnnouncement(afterStep);
            if (speech) announceSpeech(speech);
          }
        };
        pushLiveActivityUpdate({
          exerciseName: `${s.from} → ${s.to}`, targetDisplay: '',
          remainingSecs: s.seconds,
          nextExerciseName: afterTransStep ? laGetExerciseName(afterTransStep) : 'Complete',
          nextTargetDisplay: afterTransStep ? laGetTargetDisplay(afterTransStep) : '',
          elapsedSecs: elapsed, stationIndex: next + 1, totalStations: totalSteps,
          currentPace: '', isRest: true,
        });
      } else {
        setPhase('active');
        const speech = buildSpeechAnnouncement(nextStep);
        if (speech) announceSpeech(speech);
        const laNext = steps[next + 1];
        const nextDur = 'exercise' in nextStep ? (parseDurationSecs(String((nextStep as any).exercise?.reps ?? '')) ?? 0) : 0;
        laStepNameRef.current    = laGetExerciseName(nextStep);
        laStepTargetRef.current  = laGetTargetDisplay(nextStep);
        laNextNameRef.current    = laNext ? laGetExerciseName(laNext) : 'Complete';
        laNextTargetRef.current  = laNext ? laGetTargetDisplay(laNext) : '';
        laStepIndexRef.current   = next + 1;
        currentStepDuration.current = nextDur;
        stepStartElapsed.current = elapsedRef.current;
        pushLiveActivityUpdate({
          exerciseName: laStepNameRef.current, targetDisplay: laStepTargetRef.current,
          remainingSecs: nextDur,
          nextExerciseName: laNextNameRef.current,
          nextTargetDisplay: laNextTargetRef.current,
          elapsedSecs: elapsedRef.current, stationIndex: next + 1, totalStations: totalSteps,
          currentPace: laGetPace(nextStep), isRest: false,
          timerEndDate: nextDur > 0 ? Date.now() + nextDur * 1000 : undefined,
        });
      }
    }
  }, [steps, stepIdx, totalSteps]); // eslint-disable-line react-hooks/exhaustive-deps

  function triggerRest(secs: number, label: string) {
    setRestSecs(secs);
    setRestLabel(label);
    setPhase('rest');
    startTimeRef.current = Date.now();
    currentTimerDuration.current = secs;
    const nextStep = steps[stepIdx + 1];
    nextExerciseNameRef.current = nextStep && 'exercise' in nextStep ? (nextStep as any).exercise.name : 'Next exercise';
    afterRest.current = () => {
      startTimeRef.current = 0;
      Notifications.cancelAllScheduledNotificationsAsync().catch(() => {});
      const next = stepIdx + 1;
      if (next >= totalSteps) { setPhase('complete'); }
      else { setStepIdx(next); setPhase('active'); setWeightInput(''); setRepsInput(''); }
    };
    const trNext = steps[stepIdx + 1];
    pushLiveActivityUpdate({
      exerciseName: 'REST', targetDisplay: '',
      remainingSecs: secs,
      nextExerciseName: trNext ? laGetExerciseName(trNext) : 'Complete',
      nextTargetDisplay: trNext ? laGetTargetDisplay(trNext) : '',
      elapsedSecs: elapsed, stationIndex: stepIdx + 1, totalStations: totalSteps,
      currentPace: '', isRest: true,
    });
  }

  const onRestDone = useCallback(() => {
    startTimeRef.current = 0;
    Notifications.cancelAllScheduledNotificationsAsync().catch(() => {});
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

  async function saveSession(full: boolean): Promise<string | null> {
    if (!userId) return null;
    setSaving(true);
    let insertedId: string | null = null;
    try {
      const { data } = await supabase.from('session_logs').insert({
        user_id:      userId,
        program_id:   programId,
        day_name:     dayName,
        week_number:  weekNumber,
        session_name: session.name,
        log_field:    'live_workout',
        log_value:    metconFinalRounds > 0
          ? `${Math.round(elapsed / 60)} min · ${metconFinalRounds} rds`
          : `${Math.round(elapsed / 60)} min`,
        duration:     elapsed,
        weights_used: loggedSets.length > 0 ? JSON.stringify(loggedSets) : null,
        rpe:          full ? rpe : null,
        rpe_logged:   full ? rpe : null,
        completed:    full,
        completed_at: new Date().toISOString(),
      }).select('id').single();
      insertedId = (data as any)?.id ?? null;
      if (insertedId) setSavedLogId(insertedId);
    } catch (e) {
      console.log('[live-workout] save error:', e);
    }
    setSaving(false);
    return insertedId;
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

  async function skipWarmup() {
    const firstNonWarmup = steps.findIndex(s => !isWarmupStep(s));
    if (firstNonWarmup <= 0) return;
    setStepIdx(firstNonWarmup);
    setPhase('active');
    AsyncStorage.setItem(`skip_warmup_${programId}_${dayName}`, '1').catch(() => {});
    if (userId) {
      Promise.resolve(supabase.from('session_logs').insert({
        user_id: userId, program_id: programId, day_name: dayName, week_number: weekNumber,
        session_name: session.name, log_field: 'warmup_skipped', log_value: '1',
        completed: false, completed_at: new Date().toISOString(),
      })).catch(() => {});
      fetch('https://peak65.vercel.app/api/ai-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, triggerType: 'warmup_skipped', sessionData: { sessionName: session.name } }),
      }).catch(() => {});
    }
  }

  async function skipCooldown() {
    setPhase('complete');
    if (userId) {
      Promise.resolve(supabase.from('session_logs').insert({
        user_id: userId, program_id: programId, day_name: dayName, week_number: weekNumber,
        session_name: session.name, log_field: 'cooldown_skipped', log_value: '1',
        completed: false, completed_at: new Date().toISOString(),
      })).catch(() => {});
      fetch('https://peak65.vercel.app/api/ai-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, triggerType: 'cooldown_skipped', sessionData: { sessionName: session.name } }),
      }).catch(() => {});
    }
  }

  function firePostSessionCalls() {
    if (!userId) return;
    fetch('https://peak65.vercel.app/api/update-athlete-intelligence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    }).catch(() => {});
    fetch('https://peak65.vercel.app/api/ai-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        triggerType: 'session_complete',
        sessionData: { sessionName: session.name, duration: elapsed },
      }),
    }).catch(() => {});
  }

  async function saveAndExit() {
    const logId = await saveSession(true);
    if (logId && userId) {
      fetch('https://peak65.vercel.app/api/update-athlete-intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      }).catch(() => {});
      fetch('https://peak65.vercel.app/api/ai-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          triggerType: 'session_complete',
          sessionData: { sessionName: session.name, duration: elapsed },
        }),
      }).catch(() => {});
    }
    if (logId) {
      setHrZoneStep('prompt');
    } else {
      navigation.goBack();
    }
  }

  // ── COMPLETE ─────────────────────────────────────────────────────────────────

  if (phase === 'complete') {
    if (hrZoneStep === 'prompt') {
      return (
        <SafeAreaView style={s.container}>
          <StatusBar barStyle="light-content" />
          <ScrollView contentContainerStyle={s.centerPad}>
            <Text style={s.completeTitle}>SESSION{'\n'}COMPLETE.</Text>
            <Text style={s.completeSub}>{session.name}</Text>
            <View style={{ height: 1, backgroundColor: '#222', width: '100%', marginVertical: 24 }} />
            <Text style={[s.rpeLabel, { marginBottom: 8 }]}>ADD YOUR HEART RATE ZONES?</Text>
            <Text style={{ color: Colors.textSecondary, fontSize: 13, textAlign: 'center', lineHeight: 19, marginBottom: 28 }}>
              Upload a screenshot from Whoop, Garmin, Polar, or any HR app. Your coach uses zone data to optimise future sessions.
            </Text>
            <TouchableOpacity
              style={[s.primaryBtn, { marginBottom: 16 }]}
              onPress={() => setHrZoneStep('uploading')}
            >
              <Text style={s.primaryBtnTxt}>UPLOAD SCREENSHOT</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { firePostSessionCalls(); navigation.goBack(); }}>
              <Text style={{ color: Colors.textSecondary, fontSize: 13 }}>Skip for now</Text>
            </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      );
    }

    if (hrZoneStep === 'uploading') {
      return (
        <HRZoneUploader
          sessionLogId={savedLogId}
          userId={userId}
          onDone={() => { firePostSessionCalls(); navigation.goBack(); }}
          onSkip={() => navigation.goBack()}
        />
      );
    }

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
  if (!currentStep) {
    // phase is narrowed by guards above; cast avoids false TS2367 error
    if ((phase as string) !== 'complete') setPhase('complete');
    return null;
  }

  const isHyroxStation = 'exercise' in currentStep && isDistanceBasedExercise((currentStep as any).exercise.name) && !isWarmupStep(currentStep) && !isCooldownStep(currentStep);

  const exitModalEl = (
    <Modal
      visible={exitModalVisible}
      transparent
      animationType="slide"
      onRequestClose={() => setExitModalVisible(false)}
    >
      <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' }} activeOpacity={1} onPress={() => setExitModalVisible(false)} />
      <View style={{ backgroundColor: '#111111', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 40 }}>
        <View style={{ width: 40, height: 4, backgroundColor: '#333333', borderRadius: 2, alignSelf: 'center', marginBottom: 24 }} />
        <Text style={{ color: '#f0ede8', fontSize: 20, fontWeight: '800', marginBottom: 24 }}>End workout?</Text>
        <TouchableOpacity
          style={{ backgroundColor: Colors.accent, borderRadius: 12, padding: 16, alignItems: 'center', marginBottom: 16 }}
          onPress={() => { setExitModalVisible(false); setPhase('complete'); }}
        >
          <Text style={{ color: '#080808', fontSize: 15, fontWeight: '800' }}>End Session</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={{ alignItems: 'center', padding: 8 }}
          onPress={() => {
            setExitModalVisible(false);
            Alert.alert('Abandon workout?', 'All progress will be lost.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Abandon', style: 'destructive', onPress: () => { endLiveActivity(); navigation.goBack(); } },
            ]);
          }}
        >
          <Text style={{ color: '#8a877f', fontSize: 14 }}>Abandon Workout</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );

  if (isHyroxStation) {
    return (
      <SafeAreaView style={s.container}>
        <StatusBar barStyle="light-content" />
        <ProgressBar done={stepIdx} total={totalSteps} />
        <TouchableOpacity
          style={{ position: 'absolute', top: 8, left: 16, zIndex: 10, padding: 8 }}
          onPress={() => setExitModalVisible(true)}
        >
          <Feather name="x" color={Colors.textSecondary} size={22} />
        </TouchableOpacity>
        <HyroxTapZone
          exerciseName={(currentStep as any).exercise.name}
          target={String((currentStep as any).exercise.reps ?? '')}
          elapsed={stepElapsed}
          onDone={advance}
        />
        {exitModalEl}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.container}>
      <StatusBar barStyle="light-content" />
      <ProgressBar done={stepIdx} total={totalSteps} />
      <TouchableOpacity
        style={{ position: 'absolute', top: 8, left: 16, zIndex: 10, padding: 8 }}
        onPress={() => setExitModalVisible(true)}
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
          onFinish={() => { setMetconFinalRounds(metconRounds); setMetconRunning(false); setMetconComplete(true); advance(); }}
        />
      )}

      {(currentStep.kind === 'generic') && (
        <GenericPhase
          key={stepIdx}
          step={currentStep}
          isLast={stepIdx === totalSteps - 1}
          onDone={advance}
          onSkipWarmup={isWarmupStep(currentStep) ? skipWarmup : undefined}
          onSkipCooldown={isCooldownStep(currentStep) ? skipCooldown : undefined}
        />
      )}

      {currentStep.kind === 'run_interval' && (
        <RunIntervalPhase
          key={stepIdx}
          step={currentStep}
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
      {exitModalEl}
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
  const isTimed  = isAMRAP || isEMOM;

  const completedRef = useRef(false);
  useEffect(() => {
    if (isTimed && timeLeft <= 0 && running && !completedRef.current) {
      completedRef.current = true;
      onFinish();
    }
  }, [timeLeft, running, isTimed, onFinish]);

  return (
    <ScrollView contentContainerStyle={mc.container}>
      <Text style={mc.format}>
        {format}{isTimed ? ` · ${Math.round(step.timeCap / 60)} MIN` : ''}
      </Text>

      {isTimed ? (
        <>
          <Text style={mc.timer}>{formatTime(timeLeft)}</Text>
          <Text style={mc.roundsLarge}>{rounds} RDS</Text>
        </>
      ) : (
        <Text style={mc.timer}>{rounds} RDS</Text>
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
        <Text style={mc.roundBtnTxt}>+ ROUND</Text>
      </TouchableOpacity>

      <TouchableOpacity style={[s.primaryBtn, { marginTop: 20 }]} onPress={onFinish}>
        <Text style={s.primaryBtnTxt}>FINISH METCON →</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}
const mc = StyleSheet.create({
  container:   { padding: 24, paddingTop: 56, paddingBottom: 60 },
  format:      { color: Colors.textSecondary, fontSize: 13, fontWeight: '700', letterSpacing: 2, marginBottom: 8 },
  timer:       { color: Colors.accent, fontSize: 72, fontFamily: Fonts.metricHeavy, fontVariant: ['tabular-nums' as const] },
  roundsLarge: { color: Colors.accent, fontSize: 48, fontWeight: '800', marginTop: 4, marginBottom: 4 },
  movList:     { gap: 12, marginBottom: 28, marginTop: 16 },
  movRow:      { borderLeftWidth: 3, borderLeftColor: Colors.accent, paddingLeft: 12, gap: 2 },
  movName:     { color: Colors.textPrimary, fontSize: 16, fontWeight: '600' },
  movReps:     { color: Colors.accent, fontSize: 14, fontWeight: '700' },
  movNote:     { color: Colors.textSecondary, fontSize: 13 },
  roundBtn:    { backgroundColor: Colors.card, borderRadius: 14, padding: 20, alignItems: 'center', borderWidth: 2, borderColor: Colors.accent },
  roundBtnTxt: { color: Colors.accent, fontSize: 18, fontWeight: '800', letterSpacing: 1 },
});

// ─── Generic Phase (warm-up / cool-down) ─────────────────────────────────────

function IntervalCountdown({ seconds, onDone, exerciseName, announceWarnings }: {
  seconds: number;
  onDone: () => void;
  exerciseName?: string;
  announceWarnings?: boolean;
}) {
  const [rem, setRem] = useState(seconds);
  const announcedWarnings = useRef(new Set<string>());
  useEffect(() => { setRem(seconds); announcedWarnings.current = new Set(); }, [seconds]);
  useEffect(() => {
    if (rem <= 0) {
      try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}); } catch {}
      playBeep(880, 400);
      Vibration.vibrate([0, 200, 100, 200]);
      onDone();
      return;
    }
    if (announceWarnings) {
      if (rem === 30 && !announcedWarnings.current.has('30')) {
        announcedWarnings.current.add('30');
        announceSpeech(`${exerciseName ? exerciseName + '. ' : ''}30 seconds. Push.`);
      } else if (rem === 10 && !announcedWarnings.current.has('10')) {
        announcedWarnings.current.add('10');
        announceSpeech('10 seconds. Finish strong.');
      }
    }
    if (rem === 3) {
      try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}); } catch {}
      playBeep(440, 150);
    }
    const id = setTimeout(() => setRem(r => r - 1), 1000);
    return () => clearTimeout(id);
  }, [rem, onDone, announceWarnings, exerciseName]);
  const pct = seconds > 0 ? Math.min((seconds - rem) / seconds, 1) : 1;
  return (
    <View style={{ alignItems: 'center', marginTop: 16 }}>
      <Text style={{ color: Colors.accent, fontSize: 72, fontFamily: Fonts.metricHeavy, fontVariant: ['tabular-nums' as const] }}>
        {formatTime(rem)}
      </Text>
      <View style={{ width: '60%', height: 3, backgroundColor: '#222', borderRadius: 2, marginTop: 8, overflow: 'hidden' }}>
        <View style={{ height: 3, width: `${Math.round(pct * 100)}%` as unknown as number, backgroundColor: Colors.accent, borderRadius: 2 }} />
      </View>
    </View>
  );
}

function GenericPhase({
  step, isLast, onDone, onSkipWarmup, onSkipCooldown,
}: {
  step: Extract<Step, { kind: 'generic' }>;
  isLast: boolean;
  onDone: () => void;
  onSkipWarmup?: () => void;
  onSkipCooldown?: () => void;
}) {
  const ex = step.exercise;
  const durationSecs = parseDurationSecs(String(ex.reps ?? ''));
  const detail = !durationSecs && ex.sets && ex.reps ? `${ex.sets} × ${ex.reps}` : (ex.reps ?? '');
  return (
    <View style={gp.container}>
      <View style={gp.header}>
        <Text style={gp.blockLabel}>{step.blockName.toUpperCase()}</Text>
        {onSkipWarmup && (
          <TouchableOpacity onPress={onSkipWarmup}>
            <Text style={gp.skipBtn}>SKIP WARMUP</Text>
          </TouchableOpacity>
        )}
        {onSkipCooldown && (
          <TouchableOpacity onPress={onSkipCooldown}>
            <Text style={gp.skipBtn}>SKIP COOLDOWN</Text>
          </TouchableOpacity>
        )}
      </View>
      <Text style={gp.name}>{ex.name}</Text>
      {!!detail && !durationSecs && <Text style={gp.detail}>{detail}</Text>}
      {!!(ex.notes || ex.note) && <Text style={gp.note}>{ex.notes || ex.note}</Text>}
      {durationSecs ? (
        <IntervalCountdown seconds={durationSecs} onDone={onDone} />
      ) : (
        <TouchableOpacity style={[s.primaryBtn, gp.btn]} onPress={onDone}>
          <Text style={s.primaryBtnTxt}>{isLast ? 'FINISH' : 'DONE →'}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}
const gp = StyleSheet.create({
  container:  { flex: 1, padding: 28, justifyContent: 'center' },
  header:     { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 28, alignItems: 'center' },
  blockLabel: { color: Colors.textSecondary, fontSize: 11, fontWeight: '700', letterSpacing: 2 },
  elapsed:    { color: Colors.textSecondary, fontSize: 13, fontVariant: ['tabular-nums' as const] },
  name:       { color: Colors.textPrimary, fontSize: 34, fontWeight: '800', lineHeight: 40, marginBottom: 10 },
  detail:     { color: Colors.textSecondary, fontSize: 16, marginBottom: 8 },
  note:       { color: Colors.textSecondary, fontSize: 14, lineHeight: 20, marginBottom: 24 },
  btn:        { marginTop: 40 },
  skipBtn:    { color: Colors.textSecondary, fontSize: 11, fontWeight: '600', letterSpacing: 1, textDecorationLine: 'underline' },
});

// ─── Run Interval Phase ───────────────────────────────────────────────────────

function RunIntervalPhase({
  step, swapLabel, isLast, onDone, onOpenSwap,
}: {
  step: Extract<Step, { kind: 'run_interval' }>;
  swapLabel: string | null;
  isLast: boolean;
  onDone: () => void;
  onOpenSwap: () => void;
}) {
  const ex         = step.exercise;
  const paceTarget = extractPaceTarget(ex);
  function applySwapLabel(original: string, swap: string): string {
    const s = swap.toLowerCase();
    if (s.includes('ski')) return original.replace(/\b(run|running)\b/gi, 'Ski Erg') || 'Ski Erg';
    if (s.includes('row')) return original.replace(/\b(run|running)\b/gi, 'Row Erg') || 'Row Erg';
    return original.replace(/\b(run|running)\b/gi, swap) || swap;
  }
  const displayName = swapLabel ? applySwapLabel(ex.name, swapLabel) : ex.name;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={rp.container}>
        <View style={rp.header}>
          <Text style={rp.blockLabel}>{step.blockName.toUpperCase()} · INTERVAL {step.intervalNum} OF {step.totalIntervals}</Text>
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

        {(() => {
          const durationSecs = parseDurationSecs(String(ex.reps ?? ''));
          if (durationSecs) {
            return <IntervalCountdown seconds={durationSecs} onDone={onDone} exerciseName={ex.name} announceWarnings={true} />;
          }
          return (
            <TouchableOpacity style={[s.primaryBtn, { marginTop: 32 }]} onPress={onDone}>
              <Text style={s.primaryBtnTxt}>{isLast ? 'FINISH' : step.intervalNum === step.totalIntervals ? 'DONE →' : 'NEXT INTERVAL →'}</Text>
            </TouchableOpacity>
          );
        })()}
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
  const isBW       = isBodyweightExercise(ex.name);

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

        {!isBW && lastWeight && <Text style={sp.lastWeight}>Last set: {lastWeight} lbs</Text>}

        <View style={sp.inputRow}>
          <View style={isBW ? { flex: 1 } : sp.inputGroup}>
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
          {!isBW && (
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
          )}
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

// ─── Hyrox Tap Zone ───────────────────────────────────────────────────────────

function HyroxTapZone({
  exerciseName, target, elapsed, onDone,
}: {
  exerciseName: string;
  target: string;
  elapsed: number;
  onDone: () => void;
}) {
  const pulseAnim = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.8, duration: 1500, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 0.3, duration: 1500, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulseAnim]);

  function handleTap() {
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {}); } catch {}
    onDone();
  }

  return (
    <TouchableOpacity
      style={{ flex: 1, backgroundColor: '#080808', alignItems: 'center', justifyContent: 'center' }}
      activeOpacity={1}
      onPress={handleTap}
    >
      <Animated.View
        style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          borderWidth: 3, borderColor: Colors.accent, opacity: pulseAnim,
        }}
      />
      <Text style={{ position: 'absolute', top: 16, right: 20, color: '#8a877f', fontSize: 16, fontVariant: ['tabular-nums' as const] }}>
        {formatTime(elapsed)}
      </Text>
      <Text style={{ color: '#f0ede8', fontSize: 32, fontWeight: '800', textAlign: 'center', marginBottom: 12, paddingHorizontal: 24 }}>
        {exerciseName}
      </Text>
      <Text style={{ color: '#8a877f', fontSize: 20, marginBottom: 48, textAlign: 'center' }}>
        {target}
      </Text>
      <Tooltip id="tap_zone" text="Tap anywhere on screen when you finish this station. Your time is recorded automatically." arrowDirection="down">
        <Text style={{ color: Colors.accent, fontSize: 16, fontWeight: '700', letterSpacing: 2, textAlign: 'center' }}>
          TAP ANYWHERE WHEN DONE
        </Text>
      </Tooltip>
    </TouchableOpacity>
  );
}

// ─── HR Zone Uploader ─────────────────────────────────────────────────────────

function HRZoneUploader({
  sessionLogId, userId, onDone, onSkip,
}: {
  sessionLogId: string | null;
  userId: string | null;
  onDone: () => void;
  onSkip: () => void;
}) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  async function pickAndUpload() {
    let ImagePicker: any;
    try {
      ImagePicker = require('expo-image-picker');
    } catch {
      Alert.alert('Not available', 'expo-image-picker is not installed. Run: npx expo install expo-image-picker');
      return;
    }

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission required', 'Please allow access to your photo library.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      base64: true,
      quality: 0.85,
    });

    if (result.canceled || !result.assets?.[0]?.base64) return;

    setStatus('loading');
    try {
      const base64Image = result.assets[0].base64 as string;
      const res = await fetch('https://peak65.vercel.app/api/extract-hr-zones', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64Image, sessionLogId, userId }),
      });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const responseData = await res.json();
      const zones = (responseData.zones ?? responseData) as Record<string, number>;

      if (sessionLogId && userId) {
        await supabase
          .from('session_logs')
          .update({ hr_zones: JSON.stringify(zones) })
          .eq('id', sessionLogId);
      }

      setStatus('idle');
      Alert.alert('Zones saved', 'Heart rate zone breakdown added to your session.');
      onDone();
    } catch (e: any) {
      setStatus('error');
      setErrorMsg(String(e?.message ?? e));
    }
  }

  return (
    <SafeAreaView style={s.container}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={s.centerPad}>
        <Text style={s.completeTitle}>HR{'\n'}ZONES</Text>
        <Text style={{ color: Colors.textSecondary, fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 32 }}>
          Select a screenshot showing your heart rate zone breakdown. Works with Whoop, Garmin Connect, Polar Flow, and any HR app.
        </Text>
        {status === 'loading' ? (
          <>
            <ActivityIndicator color={Colors.accent} size="large" />
            <Text style={{ color: Colors.textSecondary, fontSize: 13, marginTop: 16 }}>Extracting zones...</Text>
          </>
        ) : (
          <>
            {status === 'error' && (
              <Text style={{ color: '#ff4444', fontSize: 13, textAlign: 'center', marginBottom: 16 }}>
                {errorMsg || 'Something went wrong. Try again.'}
              </Text>
            )}
            <TouchableOpacity style={[s.primaryBtn, { marginBottom: 16 }]} onPress={pickAndUpload}>
              <Text style={s.primaryBtnTxt}>CHOOSE SCREENSHOT</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onSkip}>
              <Text style={{ color: Colors.textSecondary, fontSize: 13 }}>Skip</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

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
