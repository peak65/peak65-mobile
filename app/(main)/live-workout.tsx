/**
 * Live Workout Screen
 * Guided step-by-step session execution.
 *
 * expo-keep-awake is required for screen-on behaviour:
 *   Run: npx expo install expo-keep-awake
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  Modal, Vibration, Alert, KeyboardAvoidingView,
  Platform, StatusBar, ActivityIndicator, AppState, Animated, Dimensions, Image,
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
import Svg, { Circle as SvgCircle } from 'react-native-svg';
import { Feather } from '@expo/vector-icons';
import { Colors, Fonts } from '../../lib/theme';
import Tooltip from '../components/Tooltip';
import { startLiveActivity as laStart, updateLiveActivity as laUpdate, endLiveActivity as laEnd } from '../../modules/live-activity';
import { LinearGradient } from 'expo-linear-gradient';

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
  | 'strength_exercise'  // all sets of one strength exercise
  | 'timed_interval'     // cardio interval with countdown timer
  | 'rest'               // timed rest
  | 'generic'            // warm-up / cool-down exercise, tap DONE
  | 'metcon'             // full metcon block (AMRAP / EMOM / Rounds)
  | 'z2_cardio';         // Z2 session with elapsed timer

type Step =
  | { kind: 'strength_exercise'; exercise: ExerciseItem; totalSets: number; blockName: string }
  | { kind: 'timed_interval';    exercise: ExerciseItem; intervalNum: number; totalIntervals: number; durationSecs: number; blockName: string }
  | { kind: 'rest';              seconds: number; label: string }
  | { kind: 'generic';           exercise: ExerciseItem; blockName: string }
  | { kind: 'metcon';            block: SessionBlock; format: 'amrap' | 'emom' | 'rounds'; timeCap: number }
  | { kind: 'z2_cardio';         session: ProgramSession };

type LoggedSet = { exerciseName: string; set: number; weight: string; reps: string };
type LoggedSetData = { setNum: number; weight: string; reps: string; rir: number | null };
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
    case 'timed_interval': {
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
  'push up', 'push-up', 'pushup',
  'pull up', 'pull-up', 'pullup',
  'chin up', 'chin-up', 'chinup',
  'burpee',
  'air squat',
  'bodyweight',
  'banded',
  'plank',
  'ttb', 'toes to bar', 'toes-to-bar',
  'leg raise',
  'rollout',
  'hollow hold', 'hollow body',
  'mountain climber',
  'bear crawl',
  'inchworm',
  'v-up', 'v up',
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

function getExerciseDurationSecs(ex: ExerciseItem): number | null {
  if ((ex as any).duration) return parseDurationSecs((ex as any).duration);
  return parseDurationSecs(String(ex.reps ?? ''));
}

function getZoneColor(paceZone: string | undefined): string {
  if (!paceZone) return Colors.accent;
  if (/z1|zone\s*1|recovery|easy/i.test(paceZone)) return Colors.green;
  if (/z2|zone\s*2/i.test(paceZone)) return Colors.green;
  if (/z3|zone\s*3|tempo/i.test(paceZone)) return Colors.yellow;
  if (/z4|zone\s*4|threshold/i.test(paceZone)) return Colors.accent;
  if (/z5|zone\s*5|max/i.test(paceZone)) return Colors.red;
  return Colors.accent;
}

function getZoneTint(paceZone: string | undefined): string {
  if (!paceZone) return 'rgba(232,255,71,0.025)';
  if (/z1|zone\s*1|recovery|easy/i.test(paceZone)) return 'rgba(0,212,170,0.025)';
  if (/z2|zone\s*2/i.test(paceZone)) return 'rgba(0,212,170,0.025)';
  if (/z3|zone\s*3|tempo/i.test(paceZone)) return 'rgba(232,255,71,0.025)';
  if (/z4|zone\s*4|threshold/i.test(paceZone)) return 'rgba(232,255,71,0.035)';
  if (/z5|zone\s*5|max/i.test(paceZone)) return 'rgba(255,59,59,0.025)';
  return 'rgba(232,255,71,0.025)';
}

function isCardioExercise(ex: ExerciseItem): boolean {
  if ((ex as any).type === 'cardio' || (ex as any).type === 'z2_cardio') return true;
  return isRunExercise(ex);
}

function isStrengthExerciseNew(ex: ExerciseItem, blockName: string): boolean {
  if ((ex as any).type === 'strength' || (ex as any).type === 'bodyweight') return true;
  return isStrengthExercise(ex, blockName);
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
  return /z2|zone\s*2|easy|aerobic/i.test(session.name);
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

function nextStepLabel(step: Step | null | undefined): { name: string; detail: string } {
  if (!step) return { name: '', detail: '' };
  if (step.kind === 'strength_exercise') return { name: step.exercise.name, detail: `${step.totalSets} sets` };
  if (step.kind === 'timed_interval')    return { name: step.exercise.name, detail: `Interval ${step.intervalNum}/${step.totalIntervals}` };
  if (step.kind === 'generic')           return { name: step.exercise.name, detail: step.exercise.reps ? String(step.exercise.reps) : '' };
  if (step.kind === 'metcon')            return { name: step.block.block_name, detail: step.format.toUpperCase() };
  if (step.kind === 'rest')              return { name: 'Rest', detail: formatTime(step.seconds) };
  return { name: '', detail: '' };
}

function getCategoryLabel(step: Step): string {
  switch (step.kind) {
    case 'strength_exercise': return step.blockName;
    case 'generic':           return step.blockName;
    case 'timed_interval':    return `${step.blockName} · ${step.intervalNum}/${step.totalIntervals}`;
    case 'metcon':            return step.block.block_name;
    case 'z2_cardio':         return 'ZONE 2';
    case 'rest':              return 'REST';
    default:                  return '';
  }
}

function buildSteps(session: ProgramSession): Step[] {
  const steps: Step[] = [];

  if (isZ2Session(session)) {
    steps.push({ kind: 'z2_cardio', session });
    return steps;
  }

  const blocks = session.blocks ?? [];

  for (const block of blocks) {
    const bKind = classifyBlock(block);
    const exercises = block.exercises ?? [];

    if (bKind === 'warmup' || bKind === 'cooldown') {
      for (const ex of exercises) {
        steps.push({ kind: 'generic', exercise: ex, blockName: block.block_name });
      }
      continue;
    }

    if (bKind === 'metcon') {
      steps.push({ kind: 'metcon', block, format: detectMetconFormat(block), timeCap: extractTimeCap(block) });
      continue;
    }

    for (const ex of exercises) {
      if (isCardioExercise(ex)) {
        const total = ex.sets ?? 1;
        const durSecs = getExerciseDurationSecs(ex);
        for (let i = 0; i < total; i++) {
          if (durSecs) {
            steps.push({ kind: 'timed_interval', exercise: ex, intervalNum: i + 1, totalIntervals: total, durationSecs: durSecs, blockName: block.block_name });
          } else {
            steps.push({ kind: 'generic', exercise: ex, blockName: block.block_name });
          }
          if (i < total - 1) {
            steps.push({ kind: 'rest', seconds: parseRestSeconds(ex.rest, 120), label: 'Recovery' });
          }
        }
      } else if (isStrengthExerciseNew(ex, block.block_name)) {
        steps.push({ kind: 'strength_exercise', exercise: ex, totalSets: ex.sets ?? 1, blockName: block.block_name });
      } else {
        steps.push({ kind: 'generic', exercise: ex, blockName: block.block_name });
      }
    }
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
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const prevDone = useRef(done);

  useEffect(() => {
    if (done !== prevDone.current) {
      prevDone.current = done;
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.4, duration: 80, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();
    }
  }, [done, pulseAnim]);

  return (
    <View style={pb.track}>
      <Animated.View
        style={[pb.fill, { width: `${Math.round(pct * 100)}%` as unknown as number, opacity: pulseAnim }]}
      />
    </View>
  );
}
const pb = StyleSheet.create({
  track: { height: 3, backgroundColor: '#1a1a1a', width: '100%' },
  fill:  { height: 3, backgroundColor: Colors.accent },
});

// ─── Workout Top Bar ──────────────────────────────────────────────────────────

function WorkoutTopBar({ categoryLabel, elapsed, onExit }: { categoryLabel: string; elapsed: number; onExit: () => void }) {
  return (
    <View style={tb.bar}>
      <TouchableOpacity onPress={onExit} style={tb.exitBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
        <Feather name="x" color="#8a877f" size={22} />
      </TouchableOpacity>
      <Text style={tb.category} numberOfLines={1}>{categoryLabel.toUpperCase()}</Text>
      <Text style={tb.elapsed}>{formatTime(elapsed)}</Text>
    </View>
  );
}
const tb = StyleSheet.create({
  bar:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
  exitBtn:  { padding: 4, width: 40 },
  category: { color: '#8a877f', fontSize: 11, fontWeight: '700', letterSpacing: 2, flex: 1, textAlign: 'center' },
  elapsed:  { color: '#e8ff47', fontSize: 28, fontFamily: Fonts.metricHeavy, fontVariant: ['tabular-nums' as const], width: 80, textAlign: 'right' },
});

const RC_SIZE  = Math.min(Dimensions.get('window').width * 0.72, 280);
const RC_CX    = RC_SIZE / 2;
const RC_CY    = RC_SIZE / 2;
const RC_R     = RC_SIZE * 0.4;
const RC_SW    = 3;
const RC_CIRC  = 2 * Math.PI * RC_R;

function RestCountdown({
  seconds, onSkip, lastLoggedSet, onGoBack, nextName, nextDetail,
}: {
  seconds: number;
  label: string;
  onSkip: () => void;
  lastLoggedSet?: LoggedSet | null;
  onGoBack?: () => void;
  nextName?: string;
  nextDetail?: string;
}) {
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

  const dashOffset = RC_CIRC * rem / Math.max(1, seconds);

  return (
    <View style={rc.container}>
      {/* Back button + what was just logged */}
      {lastLoggedSet && (
        <View style={rc.loggedSection}>
          {onGoBack && (
            <TouchableOpacity onPress={onGoBack} style={rc.backBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Feather name="arrow-left" color="#8a877f" size={15} />
              <Text style={rc.backText}>Re-log set</Text>
            </TouchableOpacity>
          )}
          <Text style={rc.loggedExName}>{lastLoggedSet.exerciseName.toUpperCase()}</Text>
          <Text style={rc.loggedValue}>
            {lastLoggedSet.weight && lastLoggedSet.weight !== 'BW'
              ? `${lastLoggedSet.weight} LBS × ${lastLoggedSet.reps} REPS`
              : `${lastLoggedSet.reps} REPS`
            }
          </Text>
        </View>
      )}

      {/* Circular ring + countdown */}
      <View style={rc.ringWrap}>
        <Svg width={RC_SIZE} height={RC_SIZE} style={{ position: 'absolute' }}>
          {/* Dim background (remaining) */}
          <SvgCircle cx={RC_CX} cy={RC_CY} r={RC_R} stroke="rgba(232,255,71,0.3)" strokeWidth={RC_SW} fill="none" />
          {/* Bright arc (elapsed) */}
          <SvgCircle
            cx={RC_CX} cy={RC_CY} r={RC_R}
            stroke="#e8ff47"
            strokeWidth={RC_SW}
            fill="none"
            strokeDasharray={RC_CIRC}
            strokeDashoffset={dashOffset}
            strokeLinecap="butt"
            transform={`rotate(-90, ${RC_CX}, ${RC_CY})`}
          />
        </Svg>
        <View style={{ width: RC_SIZE, height: RC_SIZE, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={rc.restLabel}>REST</Text>
          <Text style={rc.countdown}>{formatTime(rem)}</Text>
        </View>
      </View>

      {/* Next Up card */}
      {nextName ? (
        <View style={rc.nextCard}>
          <Text style={rc.nextLabel}>NEXT</Text>
          <View style={{ flex: 1 }}>
            <Text style={rc.nextName}>{nextName}</Text>
            {nextDetail ? <Text style={rc.nextDetail}>{nextDetail}</Text> : null}
          </View>
        </View>
      ) : null}

      <View style={{ flex: 1 }} />

      {/* Skip */}
      <TouchableOpacity onPress={onSkip} style={rc.skip}>
        <Text style={rc.skipText}>Skip rest →</Text>
      </TouchableOpacity>
    </View>
  );
}
const rc = StyleSheet.create({
  container:     { flex: 1, paddingHorizontal: 24, paddingTop: 8, paddingBottom: 16 },
  loggedSection: { marginBottom: 12 },
  backBtn:       { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 },
  backText:      { color: '#8a877f', fontSize: 13 },
  loggedExName:  { color: '#8a877f', fontSize: 11, fontWeight: '700', letterSpacing: 2, marginBottom: 6 },
  loggedValue:   { color: '#f0ede8', fontSize: 22, fontFamily: Fonts.metricHeavy },
  ringWrap:      { alignItems: 'center', justifyContent: 'center' },
  restLabel:     { color: '#8a877f', fontSize: 11, fontWeight: '700', letterSpacing: 2, marginBottom: 4 },
  countdown:     { color: '#e8ff47', fontSize: 64, fontFamily: Fonts.metricHeavy, fontVariant: ['tabular-nums' as const] },
  nextCard:      { backgroundColor: '#111111', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8 },
  nextLabel:     { color: '#8a877f', fontSize: 10, fontWeight: '700', letterSpacing: 1.5 },
  nextName:      { color: '#f0ede8', fontSize: 14, fontWeight: '600' },
  nextDetail:    { color: '#8a877f', fontSize: 12, marginTop: 2 },
  skip:          { alignItems: 'flex-end' },
  skipText:      { color: '#8a877f', fontSize: 13 },
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

// ─── Session Preview Screen ───────────────────────────────────────────────────

function SessionPreviewScreen({
  session,
  onStart,
  onBack,
}: {
  session: ProgramSession;
  onStart: () => void;
  onBack: () => void;
}) {
  const sessionName = session.name ?? '';
  const isEasy = /easy|z2|zone\s*2|recovery/i.test(sessionName);
  const isHard = /threshold|tempo|interval|hard/i.test(sessionName);
  const isStrength = /strength|squat|bench|deadlift|lift/i.test(sessionName);

  let badgeText = 'TRAINING';
  let badgeBg = 'transparent';
  let badgeBorder = '#8a877f';
  let badgeColor = '#8a877f';
  if (isEasy) { badgeText = 'EASY'; badgeBg = 'rgba(0,212,170,0.15)'; badgeBorder = '#00d4aa'; badgeColor = '#00d4aa'; }
  else if (isHard) { badgeText = 'HARD'; badgeBg = 'rgba(232,255,71,0.15)'; badgeBorder = '#e8ff47'; badgeColor = '#e8ff47'; }
  else if (isStrength) { badgeText = 'STRENGTH'; badgeBg = 'rgba(240,237,232,0.08)'; badgeBorder = '#f0ede8'; badgeColor = '#f0ede8'; }

  const blocks = session.blocks ?? [];
  const blockNames = blocks
    .map(b => b.block_name)
    .filter(n => n && n.trim().length > 0);

  const coachingLine = session.description
    ? session.description.slice(0, 140)
    : null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#080808' }} edges={['top', 'bottom']}>
      <StatusBar barStyle="light-content" />
      <TouchableOpacity
        onPress={onBack}
        style={{ position: 'absolute', top: 56, left: 20, zIndex: 10, padding: 8 }}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      >
        <Feather name="x" color="#8a877f" size={22} />
      </TouchableOpacity>

      <View style={{ flex: 1, paddingHorizontal: 28, justifyContent: 'center' }}>
        {/* Badge */}
        <View style={{
          alignSelf: 'flex-start',
          borderWidth: 1,
          borderColor: badgeBorder,
          backgroundColor: badgeBg,
          paddingHorizontal: 12,
          paddingVertical: 4,
          borderRadius: 4,
          marginBottom: 20,
        }}>
          <Text style={{ color: badgeColor, fontSize: 11, fontWeight: '700', letterSpacing: 2 }}>
            {badgeText}
          </Text>
        </View>

        {/* Session name */}
        <Text style={{
          color: '#f0ede8',
          fontSize: 48,
          fontFamily: 'BarlowCondensed_900Black',
          lineHeight: 52,
          textTransform: 'uppercase',
          marginBottom: 8,
        }}>
          {sessionName}
        </Text>

        {/* Duration */}
        {!!session.duration_minutes && (
          <Text style={{ color: '#8a877f', fontSize: 16, marginBottom: 28 }}>
            {session.duration_minutes} MIN · {session.time ?? 'AM'}
          </Text>
        )}

        {/* Block pills */}
        {blockNames.length > 0 && (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 28 }}>
            {blockNames.map((name, i) => (
              <View key={i} style={{
                backgroundColor: '#111111',
                borderRadius: 4,
                paddingHorizontal: 10,
                paddingVertical: 5,
              }}>
                <Text style={{ color: '#8a877f', fontSize: 12, fontWeight: '600', letterSpacing: 0.5 }}>
                  {name}
                </Text>
              </View>
            ))}
          </View>
        )}

        {/* Coaching line */}
        {!!coachingLine && (
          <Text style={{
            color: '#8a877f',
            fontSize: 14,
            fontStyle: 'italic',
            lineHeight: 22,
            marginBottom: 8,
          }} numberOfLines={3}>
            {coachingLine}
          </Text>
        )}
      </View>

      {/* Start button */}
      <TouchableOpacity
        onPress={onStart}
        style={{
          backgroundColor: '#e8ff47',
          marginHorizontal: 0,
          paddingVertical: 22,
          alignItems: 'center',
        }}
      >
        <Text style={{
          color: '#080808',
          fontSize: 18,
          fontFamily: 'BarlowCondensed_700Bold',
          letterSpacing: 1.5,
        }}>
          START SESSION →
        </Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
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
  const isCardioSession = steps.some(s => s.kind === 'timed_interval' || s.kind === 'z2_cardio');

  const [stepIdx,     setStepIdx]     = useState(0);
  const [phase,       setPhase]       = useState<'active' | 'rest' | 'complete'>('active');
  const [restSecs,    setRestSecs]    = useState(60);
  const [restLabel,   setRestLabel]   = useState('Rest');
  const [loggedSets,  setLoggedSets]  = useState<LoggedSet[]>([]);
  const [elapsed,     setElapsed]     = useState(0);
  const [rpe,         setRpe]         = useState(7);
  const [saving,      setSaving]      = useState(false);
  const [swapVisible, setSwapVisible] = useState(false);
  const [swapLabel,   setSwapLabel]   = useState<string | null>(null);
  const [userId,      setUserId]      = useState<string | null>(null);
  const [savedLogId,  setSavedLogId]  = useState<string | null>(null);
  const [hrZoneStep,  setHrZoneStep]  = useState<'none' | 'prompt' | 'debrief' | 'invalid' | 'network_error'>('none');
  const [debriefResult, setDebriefResult] = useState<any>(null);
  const [showPreview, setShowPreview] = useState(true);
  const [prExercise, setPrExercise] = useState<string | null>(null);
  const [showPR, setShowPR] = useState(false);
  const prAnimVal = useRef(new Animated.Value(0)).current;

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
  const phaseRef              = useRef<'active' | 'rest' | 'complete'>('active');
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

  const [previousSessionData, setPreviousSessionData] = useState<Record<string, LoggedSetData[]>>({});

  useEffect(() => {
    if (!userId || !programId) return;
    (async () => {
      try {
        const { data } = await supabase
          .from('session_logs')
          .select('weights_used')
          .eq('user_id', userId)
          .eq('program_id', programId)
          .eq('session_name', session.name)
          .eq('completed', true)
          .order('completed_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!data?.weights_used) return;
        const sets: LoggedSet[] = JSON.parse(data.weights_used as string);
        const byExercise: Record<string, LoggedSetData[]> = {};
        for (const s of sets) {
          if (!byExercise[s.exerciseName]) byExercise[s.exerciseName] = [];
          byExercise[s.exerciseName].push({ setNum: s.set, weight: s.weight, reps: s.reps, rir: null });
        }
        setPreviousSessionData(byExercise);
      } catch {}
    })();
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

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
  }, [stepIdx]); // eslint-disable-line react-hooks/exhaustive-deps

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
            if (phaseRef.current === 'rest') {
              onRestDoneRef.current();
            }
          } else {
            const remaining = Math.max(1, Math.ceil(currentTimerDuration.current - elapsed));
            if (phaseRef.current === 'rest') setRestSecs(remaining);
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
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}); } catch {}
    playBeep(660, 80);
    const next = stepIdx + 1;
    if (next >= totalSteps) { try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {}); } catch {} setPhase('complete'); }
    else {
      const nextStep = steps[next];
      setStepIdx(next);
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
          if (afterIdx >= totalSteps) { try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {}); } catch {} setPhase('complete'); }
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

  const onRestDone = useCallback(() => {
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}); } catch {}
    startTimeRef.current = 0;
    Notifications.cancelAllScheduledNotificationsAsync().catch(() => {});
    afterRest.current();
  }, []);

  function handleStrengthComplete(exerciseName: string, sets: LoggedSetData[]) {
    const newLoggedSets: LoggedSet[] = sets.map(s => ({
      exerciseName,
      set: s.setNum,
      weight: s.weight,
      reps: s.reps,
    }));
    setLoggedSets(prev => {
      const prevBest = prev
        .filter(l => l.exerciseName === exerciseName && l.weight && l.weight !== 'BW' && parseFloat(l.weight) > 0)
        .reduce((max, l) => Math.max(max, parseFloat(l.weight)), 0);
      const weightSets = sets.filter(s => s.weight && s.weight !== 'BW' && parseFloat(s.weight) > 0);
      if (weightSets.length > 0 && prevBest > 0) {
        const maxW = Math.max(...weightSets.map(s => parseFloat(s.weight)));
        if (maxW > prevBest) {
          setPrExercise(exerciseName);
          setShowPR(true);
          prAnimVal.setValue(0);
          Animated.sequence([
            Animated.timing(prAnimVal, { toValue: 1, duration: 200, useNativeDriver: true }),
            Animated.delay(1200),
            Animated.timing(prAnimVal, { toValue: 0, duration: 300, useNativeDriver: true }),
          ]).start(() => { setShowPR(false); setPrExercise(null); });
          try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {}); } catch {}
        }
      }
      return [...prev, ...newLoggedSets];
    });
    advance();
  }

  async function saveSession(full: boolean): Promise<string | null> {
    console.log('[saveSession] called with completed:', full);
    console.log('[saveSession] userId:', userId);
    console.log('[saveSession] programId:', programId);
    console.log('[saveSession] currentSession:', JSON.stringify(session?.name));
    if (!userId) {
      console.log('[saveSession] returning null at: no userId');
      return null;
    }
    setSaving(true);
    let insertedId: string | null = null;
    try {
      const { data, error } = await supabase.from('session_logs').insert({
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
      console.log('[saveSession] insert data:', JSON.stringify(data), 'error:', JSON.stringify(error));
      insertedId = (data as any)?.id ?? null;
      if (!insertedId) console.log('[saveSession] returning null at: insertedId is null after insert');
      if (insertedId) setSavedLogId(insertedId);
    } catch (e) {
      console.log('[saveSession] returning null at: caught exception:', e);
      console.log('[live-workout] save error:', e);
    }

    // Hard 3 detection — triggers next week program generation
    if (full) {
      try {
        const { data: currentProgram } = await supabase
          .from('programs')
          .select('program_data, week_number')
          .eq('user_id', userId)
          .order('week_number', { ascending: false })
          .limit(1)
          .single();

        if (currentProgram) {
          const programDays = (currentProgram.program_data as { days?: { day: string; type: string }[] })?.days || [];
          const hardDays = programDays.filter((d: { type: string }) => d.type === 'hard');
          const hard3DayName = hardDays[2]?.day;

          const { data: profile } = await supabase
            .from('profiles')
            .select('timezone, tier')
            .eq('id', userId)
            .single();

          const athleteTimezone = (profile?.timezone as string) || 'America/New_York';
          const todayDayName = new Date().toLocaleDateString('en-US', {
            weekday: 'long',
            timeZone: athleteTimezone,
          });

          const athleteTier = (profile?.tier as string) || 'ai_coached';
          if (hard3DayName && todayDayName === hard3DayName && athleteTier !== 'elite') {
            const scheduledFor = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
            await supabase
              .from('generation_queue')
              .update({ scheduled_for: scheduledFor, status: 'pending' })
              .eq('user_id', userId)
              .eq('week_number', (currentProgram.week_number as number) + 1)
              .eq('status', 'pending');
          }
        }
      } catch (err) {
        console.error('[saveSession] Hard 3 detection error:', err);
      }
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
    console.log('[hr-prompt] logId:', logId);
    console.log('[hr-prompt] userId:', userId);
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
    console.log('[hr-prompt] session steps:', JSON.stringify(steps?.map(s => s.kind)));
    console.log('[hr-prompt] isCardioSession:', isCardioSession);
    if (logId && isCardioSession) {
      setHrZoneStep('prompt');
    } else {
      navigation.goBack();
    }
  }

  const gradientColors: [string, string] = phase === 'rest'
    ? ['#080808', 'rgba(100,160,255,0.018)']
    : phase === 'complete'
    ? ['#080808', 'rgba(0,212,170,0.03)']
    : isCardioSession
    ? ['#080808', 'rgba(232,255,71,0.025)']
    : ['#080808', '#080808'];

  if (showPreview) {
    return (
      <SessionPreviewScreen
        session={session}
        onStart={() => setShowPreview(false)}
        onBack={() => navigation.goBack()}
      />
    );
  }

  // ── COMPLETE ─────────────────────────────────────────────────────────────────

  if (phase === 'complete') {
    if (hrZoneStep === 'prompt') {
      return (
        <HRUploadPrompt
          session={session}
          sessionLogId={savedLogId}
          userId={userId}
          programId={programId}
          dayName={dayName}
          onDebrief={(result) => { setDebriefResult(result); setHrZoneStep('debrief'); }}
          onInvalid={() => setHrZoneStep('invalid')}
          onNetworkError={() => setHrZoneStep('network_error')}
          onSkip={() => { firePostSessionCalls(); navigation.goBack(); }}
        />
      );
    }
    if (hrZoneStep === 'debrief') {
      return (
        <HRDebriefScreen
          result={debriefResult}
          sessionLogId={savedLogId}
          userId={userId}
          onDone={() => { firePostSessionCalls(); navigation.goBack(); }}
        />
      );
    }
    if (hrZoneStep === 'invalid') {
      return (
        <HRInvalidScreen
          onRetry={() => setHrZoneStep('prompt')}
          onSkip={() => { firePostSessionCalls(); navigation.goBack(); }}
        />
      );
    }
    if (hrZoneStep === 'network_error') {
      return (
        <HRNetworkErrorScreen
          onDone={() => { firePostSessionCalls(); navigation.goBack(); }}
        />
      );
    }

    return (
      <View style={[s.container, { position: 'relative' }]}>
        <LinearGradient colors={gradientColors} style={StyleSheet.absoluteFill} start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }} />
        <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
        <StatusBar barStyle="light-content" />
        <ProgressBar done={totalSteps} total={totalSteps} />
        <ScrollView contentContainerStyle={s.centerPad}>
          <TouchableOpacity
            onPress={confirmDiscard}
            style={{ alignSelf: 'flex-end', padding: 8, marginBottom: 8 }}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Text style={{ color: '#3a3a3a', fontSize: 13 }}>✕ Discard</Text>
          </TouchableOpacity>
          <Text style={s.completeTitle}>SESSION{'\n'}COMPLETE.</Text>
          <Text style={s.completeSub}>{session.name}</Text>
          <View style={s.statRow}>
            <View style={s.stat}><Text style={s.statVal}>{formatTime(elapsed)}</Text><Text style={s.statLbl}>ELAPSED</Text></View>
            <View style={s.stat}><Text style={s.statVal}>{loggedSets.length}</Text><Text style={s.statLbl}>SETS LOGGED</Text></View>
          </View>
          <Text style={{ color: '#8a877f', fontSize: 14, fontStyle: 'italic', textAlign: 'center', marginBottom: 32, paddingHorizontal: 32 }}>
            {loggedSets.length >= 5
              ? `${loggedSets.length} sets logged. Strong work.`
              : elapsed > 3600
              ? 'Over an hour of work. Recovery starts now.'
              : 'Session complete. Recovery starts now.'}
          </Text>
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
        </ScrollView>
        </SafeAreaView>
      </View>
    );
  }

  // ── REST ──────────────────────────────────────────────────────────────────────

  if (phase === 'rest') {
    const restNextStep = steps[stepIdx + 1] ?? null;
    const restNext = nextStepLabel(restNextStep);
    const canGoBack = false;
    const restExitModal = (
      <Modal visible={exitModalVisible} transparent animationType="slide" onRequestClose={() => setExitModalVisible(false)}>
        <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' }} activeOpacity={1} onPress={() => setExitModalVisible(false)} />
        <View style={{ backgroundColor: '#111111', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 40 }}>
          <View style={{ width: 40, height: 4, backgroundColor: '#333333', borderRadius: 2, alignSelf: 'center', marginBottom: 24 }} />
          <Text style={{ color: '#f0ede8', fontSize: 20, fontWeight: '800', marginBottom: 24 }}>End workout?</Text>
          <TouchableOpacity style={{ backgroundColor: Colors.accent, borderRadius: 12, padding: 16, alignItems: 'center', marginBottom: 16 }} onPress={() => { setExitModalVisible(false); setPhase('complete'); }}>
            <Text style={{ color: '#080808', fontSize: 15, fontWeight: '800' }}>End Session</Text>
          </TouchableOpacity>
          <TouchableOpacity style={{ alignItems: 'center', padding: 8 }} onPress={() => { setExitModalVisible(false); Alert.alert('Abandon workout?', 'All progress will be lost.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Abandon', style: 'destructive', onPress: () => { endLiveActivity(); navigation.goBack(); } }]); }}>
            <Text style={{ color: '#8a877f', fontSize: 14 }}>Abandon Workout</Text>
          </TouchableOpacity>
        </View>
      </Modal>
    );
    return (
      <View style={[s.container, { position: 'relative' }]}>
        <LinearGradient colors={gradientColors} style={StyleSheet.absoluteFill} start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }} />
        <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
        <StatusBar barStyle="light-content" />
        <WorkoutTopBar categoryLabel="REST" elapsed={elapsed} onExit={() => setExitModalVisible(true)} />
        <ProgressBar done={stepIdx} total={totalSteps} />
        <RestCountdown
          seconds={restSecs}
          label={restLabel}
          onSkip={onRestDone}
          lastLoggedSet={null}
          onGoBack={undefined}
          nextName={restNext.name}
          nextDetail={restNext.detail}
        />
        {restExitModal}
        </SafeAreaView>
      </View>
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

  const activeNextStep = steps[stepIdx + 1] ?? null;

  if (isHyroxStation) {
    return (
      <View style={[s.container, { position: 'relative' }]}>
        <LinearGradient colors={gradientColors} style={StyleSheet.absoluteFill} start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }} />
        <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
        <StatusBar barStyle="light-content" />
        <WorkoutTopBar categoryLabel={getCategoryLabel(currentStep)} elapsed={elapsed} onExit={() => setExitModalVisible(true)} />
        <ProgressBar done={stepIdx} total={totalSteps} />
        <HyroxTapZone
          exerciseName={(currentStep as any).exercise.name}
          target={String((currentStep as any).exercise.reps ?? '')}
          elapsed={stepElapsed}
          onDone={advance}
        />
        {exitModalEl}
        </SafeAreaView>
      </View>
    );
  }

  return (
    <View style={[s.container, { position: 'relative' }]}>
      <LinearGradient colors={gradientColors} style={StyleSheet.absoluteFill} start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }} />
      <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
      <StatusBar barStyle="light-content" />
      <WorkoutTopBar categoryLabel={getCategoryLabel(currentStep)} elapsed={elapsed} onExit={() => setExitModalVisible(true)} />
      <ProgressBar done={stepIdx} total={totalSteps} />

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

      {currentStep.kind === 'timed_interval' && (
        <TimedIntervalPhase
          key={stepIdx}
          step={currentStep}
          swapLabel={swapLabel}
          isLast={stepIdx === totalSteps - 1}
          onDone={advance}
          onOpenSwap={() => setSwapVisible(true)}
        />
      )}

      {currentStep.kind === 'strength_exercise' && (
        <StrengthExercisePhase
          key={currentStep.exercise.name}
          step={currentStep}
          previousSets={previousSessionData[currentStep.exercise.name] ?? []}
          onAllSetsComplete={(sets) => handleStrengthComplete(currentStep.exercise.name, sets)}
        />
      )}

      <SwapSheet
        visible={swapVisible}
        onClose={() => setSwapVisible(false)}
        onSelect={setSwapLabel}
      />
      {exitModalEl}
      <Modal visible={showPR} transparent animationType="none" statusBarTranslucent>
        <Animated.View style={{
          flex: 1,
          backgroundColor: '#e8ff47',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: prAnimVal,
        }}>
          <Text style={{
            color: '#080808',
            fontSize: 96,
            fontFamily: 'BarlowCondensed_900Black',
            letterSpacing: 4,
            lineHeight: 100,
          }}>
            NEW PR
          </Text>
          {prExercise && (
            <Text style={{
              color: '#080808',
              fontSize: 22,
              fontWeight: '600',
              marginTop: 8,
              textAlign: 'center',
              paddingHorizontal: 40,
            }}>
              {prExercise}
            </Text>
          )}
        </Animated.View>
      </Modal>
      </SafeAreaView>
    </View>
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
  const targetSecs = step.session.duration_minutes ? step.session.duration_minutes * 60 : 0;
  const pct = targetSecs > 0 ? Math.min(elapsed / targetSecs, 1) : 0;
  const ringSize = Math.min(Dimensions.get('window').width * 0.72, 280);
  const ringR = ringSize * 0.4;
  const ringCirc = 2 * Math.PI * ringR;
  const ringOffset = ringCirc * (1 - pct);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 }}>
      {/* Ring + timer */}
      <View style={{ alignItems: 'center', justifyContent: 'center', width: ringSize, height: ringSize }}>
        {targetSecs > 0 && (
          <Svg width={ringSize} height={ringSize} style={{ position: 'absolute' }}>
            <SvgCircle cx={ringSize/2} cy={ringSize/2} r={ringR} stroke="rgba(232,255,71,0.12)" strokeWidth={3} fill="none" />
            <SvgCircle
              cx={ringSize/2} cy={ringSize/2} r={ringR}
              stroke="#e8ff47" strokeWidth={3} fill="none"
              strokeDasharray={ringCirc}
              strokeDashoffset={ringOffset}
              strokeLinecap="butt"
              transform={`rotate(-90, ${ringSize/2}, ${ringSize/2})`}
            />
          </Svg>
        )}
        <View style={{ alignItems: 'center' }}>
          <Text style={{
            color: '#e8ff47',
            fontSize: 72,
            fontFamily: 'BarlowCondensed_900Black',
            fontVariant: ['tabular-nums'],
            lineHeight: 80,
          }}>
            {formatTime(elapsed)}
          </Text>
          <Text style={{ color: '#8a877f', fontSize: 11, fontWeight: '700', letterSpacing: 2, marginTop: 4 }}>
            ELAPSED
          </Text>
          {targetSecs > 0 && (
            <Text style={{ color: '#8a877f', fontSize: 13, marginTop: 6 }}>
              TARGET: {step.session.duration_minutes} MIN
            </Text>
          )}
        </View>
      </View>

      {/* Session name and description */}
      <Text style={{ color: '#8a877f', fontSize: 12, fontWeight: '700', letterSpacing: 2, marginTop: 32, textAlign: 'center' }}>
        {step.session.name.toUpperCase()}
      </Text>
      {!!step.session.description && (
        <Text style={{ color: '#8a877f', fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 8, maxWidth: 300 }}>
          {step.session.description}
        </Text>
      )}

      <View style={{ flex: 1 }} />

      {/* End button */}
      <TouchableOpacity
        onPress={onEnd}
        style={{
          backgroundColor: '#e8ff47',
          width: '100%',
          paddingVertical: 20,
          alignItems: 'center',
          borderRadius: 0,
        }}
      >
        <Text style={{
          color: '#080808',
          fontSize: 18,
          fontFamily: 'BarlowCondensed_700Bold',
          letterSpacing: 1.5,
        }}>
          END SESSION →
        </Text>
      </TouchableOpacity>
    </View>
  );
}

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

// ─── Timed Interval Phase ─────────────────────────────────────────────────────

function TimedIntervalPhase({
  step, swapLabel, isLast, onDone, onOpenSwap,
}: {
  step: Extract<Step, { kind: 'timed_interval' }>;
  swapLabel: string | null;
  isLast: boolean;
  onDone: () => void;
  onOpenSwap: () => void;
}) {
  const ex = step.exercise;
  const zoneColor = getZoneColor((ex as any).pace_zone);
  const paceTarget = extractPaceTarget(ex);
  function applySwapLabel(original: string, swap: string): string {
    const s = swap.toLowerCase();
    if (s.includes('ski')) return original.replace(/\b(run|running)\b/gi, 'Ski Erg') || 'Ski Erg';
    if (s.includes('row')) return original.replace(/\b(run|running)\b/gi, 'Row Erg') || 'Row Erg';
    return original.replace(/\b(run|running)\b/gi, swap) || swap;
  }
  const displayName = swapLabel ? applySwapLabel(ex.name, swapLabel) : ex.name;

  return (
    <ScrollView contentContainerStyle={ti.container}>
      <View style={ti.header}>
        <Text style={ti.blockLabel}>{step.blockName.toUpperCase()} · INTERVAL {step.intervalNum} OF {step.totalIntervals}</Text>
      </View>
      <Text style={[ti.name, { color: zoneColor }]}>{displayName}</Text>
      <Text style={ti.distance}>{ex.reps ?? ''}</Text>
      {paceTarget ? <Text style={[ti.pace, { color: zoneColor }]}>{paceTarget}</Text> : null}
      {!!(ex.notes || ex.note) && <Text style={ti.note}>{ex.notes || ex.note}</Text>}
      <TouchableOpacity style={ti.swapBtn} onPress={onOpenSwap}>
        <Text style={ti.swapTxt}>SWAP →</Text>
      </TouchableOpacity>
      <View style={{ alignItems: 'center', marginTop: 24 }}>
        <IntervalCountdown
          seconds={step.durationSecs}
          onDone={onDone}
          exerciseName={displayName}
          announceWarnings
        />
      </View>
    </ScrollView>
  );
}
const ti = StyleSheet.create({
  container:  { padding: 28, paddingBottom: 60, flexGrow: 1 },
  header:     { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 28 },
  blockLabel: { color: Colors.textSecondary, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, flex: 1 },
  name:       { fontSize: 32, fontWeight: '800', lineHeight: 38, marginBottom: 6 },
  distance:   { color: Colors.textSecondary, fontSize: 18, marginBottom: 16 },
  pace:       { fontSize: 28, fontFamily: Fonts.metric, marginBottom: 8 },
  note:       { color: Colors.textSecondary, fontSize: 14, lineHeight: 20, marginBottom: 12 },
  swapBtn:    { marginTop: 4 },
  swapTxt:    { color: Colors.textSecondary, fontSize: 12, fontWeight: '700', letterSpacing: 1 },
});

// ─── Strength Exercise Phase ──────────────────────────────────────────────────

function StrengthExercisePhase({
  step,
  previousSets,
  onAllSetsComplete,
}: {
  step: Extract<Step, { kind: 'strength_exercise' }>;
  previousSets: LoggedSetData[];
  onAllSetsComplete: (sets: LoggedSetData[]) => void;
}) {
  const ex = step.exercise;
  const prescribedReps = parseInt(String(ex.reps ?? '').match(/\d+/)?.[0] ?? '0') || 0;
  const isBW = (ex as any).type === 'bodyweight' || ((ex as any).type === undefined && isBodyweightExercise(ex.name));
  const restSecs = parseRestSeconds(ex.rest, step.totalSets > 3 ? 180 : 90);

  const [loggedSets, setLoggedSets] = useState<LoggedSetData[]>([]);
  const loggedSetsRef = useRef<LoggedSetData[]>([]);
  const [activeSet, setActiveSet] = useState(1);
  const [weightInput, setWeightInput] = useState('');
  const [repsInput, setRepsInput] = useState('');
  const [showRIR, setShowRIR] = useState(false);
  const [pendingSetNum, setPendingSetNum] = useState<number | null>(null);
  const pendingSetNumRef = useRef<number | null>(null);
  const [rirBySet, setRirBySet] = useState<Record<number, number>>({});
  const rirBySetRef = useRef<Record<number, number>>({});
  const [restingAfterSet, setRestingAfterSet] = useState(false);
  const [restRem, setRestRem] = useState(0);
  const logBtnScale = useRef(new Animated.Value(1)).current;
  const rowFlashAnim = useRef(new Animated.Value(0)).current;
  const rirSlideAnim = useRef(new Animated.Value(300)).current;
  const suggestionScale = useRef(new Animated.Value(1)).current;
  const headerSlideAnim = useRef(new Animated.Value(-20)).current;
  const headerFadeAnim = useRef(new Animated.Value(0)).current;
  const activeRowPulse = useRef(new Animated.Value(1)).current;

  const nameParts = ex.name.split(/\s[—–-]\s/);
  const baseName = nameParts[0] ?? ex.name;
  const modifier = nameParts[1] ?? null;
  const [noteExpanded, setNoteExpanded] = useState(false);

  useEffect(() => {
    Animated.parallel([
      Animated.spring(headerSlideAnim, { toValue: 0, useNativeDriver: true, speed: 14, bounciness: 0 }),
      Animated.timing(headerFadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }),
    ]).start();
  }, []);

  useEffect(() => {
    if (!restingAfterSet || restRem > 0) {
      if (restingAfterSet && restRem <= 0) {
        try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}); } catch {}
        playBeep(880, 400);
        Vibration.vibrate([0, 200, 100, 200]);
        setRestingAfterSet(false);
      }
      return;
    }
  }, [restingAfterSet, restRem]);

  useEffect(() => {
    if (!restingAfterSet) return;
    if (restRem <= 0) {
      try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}); } catch {}
      playBeep(880, 400);
      Vibration.vibrate([0, 200, 100, 200]);
      setRestingAfterSet(false);
      Animated.sequence([
        Animated.spring(activeRowPulse, { toValue: 1.02, useNativeDriver: true, speed: 40, bounciness: 0 }),
        Animated.spring(activeRowPulse, { toValue: 1, useNativeDriver: true, speed: 20, bounciness: 6 }),
      ]).start();
      return;
    }
    if (restRem === 3) {
      try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}); } catch {}
      playBeep(440, 150);
    }
    const id = setTimeout(() => setRestRem(r => r - 1), 1000);
    return () => clearTimeout(id);
  }, [restRem, restingAfterSet]);

  // RIR auto-dismiss after 5s
  useEffect(() => {
    if (!showRIR) return;
    const t = setTimeout(() => {
      setShowRIR(false);
      finishAfterRIR(null);
    }, 5000);
    return () => clearTimeout(t);
  }, [showRIR]); // eslint-disable-line react-hooks/exhaustive-deps

  function updateLoggedSets(sets: LoggedSetData[]) {
    loggedSetsRef.current = sets;
    setLoggedSets(sets);
  }

  function updateRirBySet(r: Record<number, number>) {
    rirBySetRef.current = r;
    setRirBySet(r);
  }

  function finishAfterRIR(pickedRIR: number | null) {
    const setNum = pendingSetNumRef.current;
    if (setNum === null) return;
    const newRir = pickedRIR !== null
      ? { ...rirBySetRef.current, [setNum]: pickedRIR }
      : rirBySetRef.current;
    if (pickedRIR !== null) updateRirBySet(newRir);

    if (setNum >= step.totalSets) {
      const finalSets = loggedSetsRef.current.map(s => ({
        ...s,
        rir: newRir[s.setNum] ?? null,
      }));
      onAllSetsComplete(finalSets);
    } else {
      setActiveSet(s => s + 1);
      setWeightInput('');
      setRepsInput('');
      setRestRem(restSecs);
      setRestingAfterSet(true);
    }
  }

  function computeSuggestion(): string | null {
    if (isBW) return null;
    if (/taper|maintenance/i.test(step.blockName)) return null;
    if (loggedSets.length === 0) {
      if (previousSets.length === 0) return null;
      const last = previousSets[previousSets.length - 1];
      const lastW = parseFloat(last.weight);
      if (!lastW || isNaN(lastW)) return null;
      let raw = lastW;
      if (last.rir !== null) {
        if (last.rir >= 3) raw = lastW + 5;
        else if (last.rir === 2) raw = lastW + 2.5;
        else if (last.rir === 1) raw = lastW;
        else raw = lastW - 5;
      }
      raw = Math.round(raw / 2.5) * 2.5;
      raw = Math.max(0, raw);
      return Number.isInteger(raw) ? String(raw) : raw.toFixed(1);
    }
    const lastSet = loggedSets[loggedSets.length - 1];
    const lastW = parseFloat(lastSet.weight ?? '0');
    const lastR = parseInt(lastSet.reps ?? '0');
    const lastRIR = rirBySet[lastSet.setNum] ?? null;
    let raw: number;
    if (lastRIR !== null) {
      if (lastRIR >= 3) raw = lastW + 5;
      else if (lastRIR === 2) raw = lastW + 2.5;
      else if (lastRIR === 1) raw = lastW;
      else raw = lastW - 5;
    } else {
      if (lastR > prescribedReps + 2) raw = lastW + 2.5;
      else if (lastR >= prescribedReps) raw = lastW;
      else raw = lastW - 5;
    }
    raw = Math.round(raw / 2.5) * 2.5;
    raw = Math.max(0, raw);
    return Number.isInteger(raw) ? String(raw) : raw.toFixed(1);
  }

  function handleLogSet() {
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {}); } catch {}
    Animated.sequence([
      Animated.spring(logBtnScale, { toValue: 0.96, useNativeDriver: true, speed: 50, bounciness: 0 }),
      Animated.spring(logBtnScale, { toValue: 1, useNativeDriver: true, speed: 30, bounciness: 4 }),
    ]).start();
    rowFlashAnim.setValue(0);
    Animated.timing(rowFlashAnim, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    rirSlideAnim.setValue(300);
    Animated.spring(rirSlideAnim, { toValue: 0, useNativeDriver: true, speed: 16, bounciness: 4 }).start();
    const numRepsDefault = String(ex.reps ?? '').match(/\d+/)?.[0] ?? String(ex.reps ?? '');
    const weightVal = isBW ? 'BW' : (weightInput || '0');
    const repsVal = repsInput || numRepsDefault;
    const newSet: LoggedSetData = { setNum: activeSet, weight: weightVal, reps: repsVal, rir: null };
    updateLoggedSets([...loggedSetsRef.current, newSet]);
    pendingSetNumRef.current = activeSet;
    setPendingSetNum(activeSet);
    setShowRIR(true);
  }

  const prevBestWeight = previousSets.length > 0
    ? previousSets.filter(s => s.weight && s.weight !== 'BW' && parseFloat(s.weight) > 0)
        .sort((a, b) => parseFloat(b.weight) - parseFloat(a.weight))[0]?.weight
    : undefined;

  const sessionBestWeight = loggedSets.filter(s => s.weight && s.weight !== 'BW' && parseFloat(s.weight) > 0)
    .sort((a, b) => parseFloat(b.weight) - parseFloat(a.weight))[0]?.weight;

  const weightValue = weightInput !== '' ? weightInput
    : sessionBestWeight ?? (prevBestWeight && prevBestWeight !== 'BW' ? prevBestWeight : '0');
  const repsValue = repsInput !== '' ? repsInput : String(prescribedReps);
  const suggestedWeight = computeSuggestion();

  useEffect(() => {
    if (!suggestedWeight || parseFloat(suggestedWeight) <= 0) return;
    Animated.sequence([
      Animated.spring(suggestionScale, { toValue: 1.08, useNativeDriver: true, speed: 50, bounciness: 0 }),
      Animated.spring(suggestionScale, { toValue: 1, useNativeDriver: true, speed: 20, bounciness: 8 }),
    ]).start();
  }, [suggestedWeight]);

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: '#080808' }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {/* Header */}
      <Animated.View style={[sp.header, { opacity: headerFadeAnim, transform: [{ translateY: headerSlideAnim }] }]}>
        <Text style={sp.setCounter}>{step.blockName.toUpperCase()} · {step.totalSets} SETS</Text>
        <Text style={sp.name}>{baseName}</Text>
        {!!modifier && <Text style={sp.modifier}>{modifier}</Text>}
        <Text style={sp.prescribed}>{ex.sets} × {ex.reps}{ex.rest ? ` · ${ex.rest} rest` : ''}</Text>
        {!!prevBestWeight && prevBestWeight !== '0' && (
          <Text style={sp.lastBest}>LAST SESSION: {prevBestWeight} LBS</Text>
        )}
        {!!(ex.notes || ex.note) && (
          <TouchableOpacity onPress={() => setNoteExpanded(v => !v)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            {noteExpanded ? (
              <Text style={sp.note}>{ex.notes || ex.note}{'\n'}<Text style={sp.coachToggle}>↑ hide</Text></Text>
            ) : (
              <Text style={sp.coachToggle}>Coach note ↓</Text>
            )}
          </TouchableOpacity>
        )}
      </Animated.View>

      {/* Set log table */}
      <ScrollView style={{ flex: 1, backgroundColor: '#080808' }} keyboardShouldPersistTaps="handled">
        {loggedSets.filter(ls => ls.setNum < activeSet).map((ls, i, arr) => (
          <Animated.View key={i} style={[sp.setRow, sp.setRowDone, i === arr.length - 1 && { opacity: rowFlashAnim }]}>
            <Text style={[sp.setLabel, sp.setLabelDone]}>SET {ls.setNum}</Text>
            <View style={sp.setValues}>
              {ls.weight && ls.weight !== 'BW' ? (
                <>
                  <Text style={sp.setValue}>{ls.weight} lbs</Text>
                  <Text style={sp.setSep}>×</Text>
                  <Text style={sp.setValue}>{ls.reps} reps</Text>
                </>
              ) : (
                <Text style={sp.setValue}>{ls.reps} reps</Text>
              )}
              {rirBySet[ls.setNum] !== undefined && (
                <View style={sp.rirPill}>
                  <Text style={sp.rirPillTxt}>RIR {rirBySet[ls.setNum]}</Text>
                </View>
              )}
            </View>
          </Animated.View>
        ))}

        {/* Inline rest OR active set row */}
        {restingAfterSet ? (
          <View style={sp.restRow}>
            <Text style={sp.restLabel}>REST</Text>
            <Text style={sp.restCountdown}>{formatTime(restRem)}</Text>
            <TouchableOpacity onPress={() => { try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}); } catch {} setRestingAfterSet(false); setRestRem(0); }}>
              <Text style={sp.restSkip}>Skip →</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <Animated.View style={[sp.setRow, sp.setRowActive, { transform: [{ scale: activeRowPulse }] }]}>
            <Text style={[sp.setLabel, sp.setLabelActive]}>SET {activeSet}</Text>
            <View style={sp.setValues}>
              {!isBW && (
                <>
                  <TextInput
                    style={sp.inputWeight}
                    value={weightInput === '0' ? '' : weightInput}
                    placeholder="— lbs"
                    placeholderTextColor="rgba(240,237,232,0.25)"
                    onChangeText={setWeightInput}
                    keyboardType="decimal-pad"
                    selectTextOnFocus
                  />
                  <Text style={sp.setSep}>×</Text>
                </>
              )}
              <TextInput
                style={sp.inputReps}
                value={repsValue}
                onChangeText={setRepsInput}
                keyboardType="number-pad"
                selectTextOnFocus
              />
            </View>
          </Animated.View>
        )}

        {!!suggestedWeight && suggestedWeight !== '0' && parseFloat(suggestedWeight) > 0 && !isBW && !restingAfterSet && (
          <Animated.Text style={[sp.suggestion, { transform: [{ scale: suggestionScale }] }]}>SUGGESTED: {suggestedWeight} lbs</Animated.Text>
        )}

        {previousSets.length > 0 && (
          <View style={sp.prevSection}>
            <Text style={sp.prevLabel}>LAST SESSION</Text>
            {previousSets.map((ps, i) => (
              <View key={i} style={sp.prevRow}>
                <Text style={sp.prevSetNum}>SET {ps.setNum}</Text>
                <Text style={sp.prevValue}>
                  {ps.weight && ps.weight !== 'BW' ? `${ps.weight} lbs × ${ps.reps} reps` : `${ps.reps} reps`}
                </Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {/* LOG SET button */}
      {!restingAfterSet && (
        <TouchableOpacity onPress={handleLogSet} activeOpacity={1} disabled={showRIR}>
          <Animated.View style={[sp.logBtn, showRIR && { opacity: 0.5 }, { transform: [{ scale: logBtnScale }] }]}>
            <Text style={sp.logBtnTxt}>LOG SET {activeSet}</Text>
          </Animated.View>
        </TouchableOpacity>
      )}

      {/* Inline RIR picker */}
      <Modal visible={showRIR} transparent animationType="none" statusBarTranslucent>
        <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => { setShowRIR(false); finishAfterRIR(null); }} />
        <Animated.View style={{ backgroundColor: '#111111', paddingHorizontal: 24, paddingTop: 20, paddingBottom: 40, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)', transform: [{ translateY: rirSlideAnim }] }}>
          <Text style={{ color: '#8a877f', fontSize: 11, fontWeight: '700', letterSpacing: 2, textAlign: 'center', marginBottom: 16 }}>REPS IN RESERVE</Text>
          <Text style={{ color: '#f0ede8', fontSize: 15, textAlign: 'center', marginBottom: 20 }}>How many more reps could you have done?</Text>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            {[0, 1, 2, 3, 4, 5].map(rir => (
              <TouchableOpacity
                key={rir}
                onPress={() => { setShowRIR(false); finishAfterRIR(rir); try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}); } catch {} }}
                style={{ flex: 1, backgroundColor: '#1a1a1a', borderRadius: 0, paddingVertical: 16, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }}
              >
                <Text style={{ color: rir === 0 ? '#ff3b3b' : rir <= 1 ? '#e8ff47' : '#f0ede8', fontSize: 22, fontFamily: 'BarlowCondensed_900Black' }}>{rir}</Text>
                <Text style={{ color: '#8a877f', fontSize: 9, letterSpacing: 1, marginTop: 2 }}>
                  {rir === 0 ? 'FAIL' : rir === 1 ? 'LIMIT' : rir >= 4 ? 'EASY' : 'RIR'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <TouchableOpacity onPress={() => { setShowRIR(false); finishAfterRIR(null); }} style={{ marginTop: 16, alignItems: 'center', paddingVertical: 8 }}>
            <Text style={{ color: '#3a3a3a', fontSize: 13 }}>Skip</Text>
          </TouchableOpacity>
        </Animated.View>
      </Modal>
    </KeyboardAvoidingView>
  );
}
const sp = StyleSheet.create({
  header:        { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' },
  setCounter:    { color: '#8a877f', fontSize: 11, fontWeight: '700', letterSpacing: 2, marginBottom: 8 },
  name:          { color: '#f0ede8', fontSize: 44, fontFamily: Fonts.metricHeavy, lineHeight: 48, marginBottom: 2 },
  modifier:      { color: '#8a877f', fontSize: 14, marginBottom: 4 },
  prescribed:    { color: '#8a877f', fontSize: 13, marginBottom: 4 },
  lastBest:      { color: '#e8ff47', fontSize: 12, fontWeight: '700', letterSpacing: 1, marginBottom: 4 },
  note:          { color: '#8a877f', fontSize: 13, fontStyle: 'italic', lineHeight: 18, marginTop: 4 },
  coachToggle:   { color: '#8a877f', fontSize: 12, letterSpacing: 0.5, marginTop: 2 },
  setRow:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14, marginBottom: 2 },
  setRowDone:    { backgroundColor: '#111111', borderLeftWidth: 3, borderLeftColor: '#00d4aa' },
  setRowActive:  { backgroundColor: '#1a1a1a', borderLeftWidth: 3, borderLeftColor: '#e8ff47', paddingVertical: 16 },
  setLabel:      { fontSize: 11, letterSpacing: 1, fontWeight: '700' },
  setLabelDone:  { color: '#8a877f' },
  setLabelActive: { color: '#e8ff47' },
  setValues:     { flexDirection: 'row', alignItems: 'center', gap: 8 },
  setValue:      { color: '#f0ede8', fontSize: 17, fontWeight: '700' },
  setSep:        { color: '#8a877f', fontSize: 13 },
  inputWeight:   { fontSize: 26, fontFamily: Fonts.metricHeavy, color: '#f0ede8', textAlign: 'center', width: 80, borderBottomWidth: 1, borderBottomColor: 'rgba(232,255,71,0.4)', paddingBottom: 2 },
  inputReps:     { fontSize: 26, fontFamily: Fonts.metricHeavy, color: '#f0ede8', textAlign: 'center', width: 60, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.2)', paddingBottom: 2 },
  rirPill:       { backgroundColor: '#1a1a1a', paddingHorizontal: 6, paddingVertical: 2, marginLeft: 4 },
  rirPillTxt:    { color: '#8a877f', fontSize: 10 },
  suggestion:    { color: '#e8ff47', fontSize: 12, letterSpacing: 1, fontWeight: '700', paddingHorizontal: 20, paddingVertical: 8 },
  restRow:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 20, backgroundColor: '#0d0d0d', borderLeftWidth: 3, borderLeftColor: 'rgba(100,160,255,0.4)', gap: 16 },
  restLabel:     { color: '#8a877f', fontSize: 11, fontWeight: '700', letterSpacing: 2 },
  restCountdown: { color: '#e8ff47', fontSize: 32, fontFamily: Fonts.metricHeavy, fontVariant: ['tabular-nums' as const], flex: 1 },
  restSkip:      { color: '#8a877f', fontSize: 13 },
  prevSection:   { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 8 },
  prevLabel:     { color: '#3a3a3a', fontSize: 10, fontWeight: '700', letterSpacing: 2, marginBottom: 8 },
  prevRow:       { flexDirection: 'row', gap: 12, paddingVertical: 4 },
  prevSetNum:    { color: '#3a3a3a', fontSize: 12, width: 48 },
  prevValue:     { color: '#3a3a3a', fontSize: 12 },
  logBtn:        { backgroundColor: '#e8ff47', paddingVertical: 22, alignItems: 'center', borderRadius: 0, width: '100%' },
  logBtnTxt:     { color: '#080808', fontSize: 20, fontFamily: Fonts.metricHeavy, letterSpacing: 1 },
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

// ─── HR Debrief Flow ──────────────────────────────────────────────────────────

type PickedImage = { base64: string; uri: string };

async function pickImage(): Promise<PickedImage | null> {
  let ImagePicker: any;
  try { ImagePicker = require('expo-image-picker'); } catch {
    Alert.alert('Not available', 'expo-image-picker is not installed.');
    return null;
  }
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    Alert.alert(
      'Photo library access required',
      'Go to Settings and allow Peak 65 to access your photos.',
      [{ text: 'OK' }],
    );
    return null;
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    base64: true,
    quality: 0.85,
  });
  if (result.canceled || !result.assets?.[0]?.base64) return null;
  return { base64: result.assets[0].base64 as string, uri: result.assets[0].uri };
}

// ── Screen 1 + 2: Upload Prompt ───────────────────────────────────────────────

function HRUploadPrompt({
  session, sessionLogId, userId, programId, dayName,
  onDebrief, onInvalid, onNetworkError, onSkip,
}: {
  session: ProgramSession;
  sessionLogId: string | null;
  userId: string | null;
  programId: string;
  dayName: string;
  onDebrief: (result: any) => void;
  onInvalid: () => void;
  onNetworkError: () => void;
  onSkip: () => void;
}) {
  const [zoneChart, setZoneChart] = useState<PickedImage | null>(null);
  const [hrCurve, setHrCurve]     = useState<PickedImage | null>(null);
  const [loading, setLoading]     = useState(false);
  const spinVal = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!loading) return;
    Animated.loop(
      Animated.timing(spinVal, { toValue: 1, duration: 900, useNativeDriver: true }),
    ).start();
    return () => { spinVal.stopAnimation(); spinVal.setValue(0); };
  }, [loading]);

  const spin = spinVal.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  async function analyze() {
    setLoading(true);
    try {
      const body: Record<string, any> = { sessionLogId, userId };
      if (zoneChart) body.zoneChartBase64 = zoneChart.base64.replace(/^data:image\/\w+;base64,/, '');
      if (hrCurve)   body.hrCurveBase64  = hrCurve.base64.replace(/^data:image\/\w+;base64,/, '');

      const res = await fetch('https://peak65.vercel.app/api/extract-hr-zones', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) { onNetworkError(); return; }

      const data = await res.json();
      if (!data.success || data.analysis?.image_valid === false) { onInvalid(); return; }

      onDebrief(data);
    } catch {
      onNetworkError();
    } finally {
      setLoading(false);
    }
  }

  const hasImage = !!(zoneChart || hrCurve);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#080808' }} edges={['top', 'bottom']}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} showsVerticalScrollIndicator={false}>

        {/* Top */}
        <View style={{ alignItems: 'center', paddingTop: 60, paddingHorizontal: 24 }}>
          <Feather name="activity" size={52} color="#e8ff47" />
          <Text style={{ fontSize: 34, fontWeight: '800', color: '#f0ede8', textAlign: 'center', marginTop: 16, fontFamily: 'BarlowCondensed_700Bold' }}>
            Your debrief is ready.
          </Text>
          <Text style={{ fontSize: 17, color: '#8a877f', textAlign: 'center', maxWidth: 280, marginTop: 8, lineHeight: 26 }}>
            Upload your heart rate data and get instant coaching feedback from your coach — specific to what your body just did.
          </Text>
        </View>

        {/* Instruction card */}
        <View style={{ backgroundColor: '#111111', borderRadius: 12, margin: 24, padding: 20 }}>
          <Text style={{ color: '#e8ff47', fontSize: 13, fontWeight: '700', letterSpacing: 1, fontFamily: 'BarlowCondensed_700Bold' }}>
            WHAT TO UPLOAD
          </Text>
          {([
            { icon: 'smartphone' as const, text: 'Open Whoop, Garmin, Apple Health, or Polar' },
            { icon: 'bar-chart-2' as const, text: "Find today's session or activity" },
            { icon: 'camera' as const, text: 'Screenshot your zone chart, your HR graph, or both' },
          ] as const).map((row, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16 }}>
              <Feather name={row.icon} size={20} color="#e8ff47" />
              <Text style={{ color: '#f0ede8', fontSize: 15, flex: 1 }}>{row.text}</Text>
            </View>
          ))}
        </View>

        {/* Tip */}
        <View style={{ backgroundColor: '#1a1a1a', borderRadius: 8, marginHorizontal: 24, padding: 12, flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
          <Feather name="info" size={16} color="#8a877f" style={{ marginTop: 2 }} />
          <Text style={{ color: '#8a877f', fontSize: 13, lineHeight: 20, flex: 1 }}>
            Zone chart = time in each zone. HR graph = your heart rate over time. Both together gives us the full picture.
          </Text>
        </View>

        {/* Upload buttons or loading */}
        <View style={{ margin: 24, gap: 12 }}>
          {loading ? (
            <View style={{ alignItems: 'center', paddingVertical: 24 }}>
              {/* Thumbnails */}
              {(zoneChart || hrCurve) && (
                <View style={{ flexDirection: 'row', gap: 12, marginBottom: 24 }}>
                  {zoneChart && (
                    <View>
                      <Image source={{ uri: zoneChart.uri }} style={{ width: 80, height: 80, borderRadius: 8 }} />
                      <View style={{ position: 'absolute', top: 4, right: 4, backgroundColor: '#00d4aa', borderRadius: 10, width: 20, height: 20, alignItems: 'center', justifyContent: 'center' }}>
                        <Feather name="check" size={12} color="#080808" />
                      </View>
                    </View>
                  )}
                  {hrCurve && (
                    <View>
                      <Image source={{ uri: hrCurve.uri }} style={{ width: 80, height: 80, borderRadius: 8 }} />
                      <View style={{ position: 'absolute', top: 4, right: 4, backgroundColor: '#00d4aa', borderRadius: 10, width: 20, height: 20, alignItems: 'center', justifyContent: 'center' }}>
                        <Feather name="check" size={12} color="#080808" />
                      </View>
                    </View>
                  )}
                </View>
              )}
              <Animated.View style={{ transform: [{ rotate: spin }] }}>
                <Feather name="refresh-cw" size={32} color="#e8ff47" />
              </Animated.View>
              <Text style={{ color: '#f0ede8', fontSize: 17, marginTop: 12 }}>Analyzing your session...</Text>
              <Text style={{ color: '#8a877f', fontSize: 14, marginTop: 4, textAlign: 'center' }}>
                Your coach is reviewing the data. This takes about 10 seconds.
              </Text>
            </View>
          ) : (
            <>
              {/* Zone Chart button */}
              <TouchableOpacity
                style={{ backgroundColor: '#111111', borderWidth: 1.5, borderColor: '#e8ff47', borderRadius: 12, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14 }}
                onPress={async () => { const img = await pickImage(); if (img) setZoneChart(img); }}
              >
                {zoneChart ? (
                  <Image source={{ uri: zoneChart.uri }} style={{ width: 40, height: 40, borderRadius: 6 }} />
                ) : (
                  <Feather name="upload" size={20} color="#e8ff47" />
                )}
                <View style={{ flex: 1 }}>
                  <Text style={{ color: '#f0ede8', fontSize: 18, fontWeight: '700', fontFamily: 'BarlowCondensed_700Bold' }}>
                    Zone Chart{zoneChart ? ' ✓' : ''}
                  </Text>
                  <Text style={{ color: '#8a877f', fontSize: 13 }}>Bar chart or pie chart showing zone breakdown</Text>
                </View>
                <Feather name="chevron-right" size={16} color="#8a877f" />
              </TouchableOpacity>

              {/* HR Graph button */}
              <TouchableOpacity
                style={{ backgroundColor: '#111111', borderWidth: 1.5, borderColor: '#e8ff47', borderRadius: 12, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14 }}
                onPress={async () => { const img = await pickImage(); if (img) setHrCurve(img); }}
              >
                {hrCurve ? (
                  <Image source={{ uri: hrCurve.uri }} style={{ width: 40, height: 40, borderRadius: 6 }} />
                ) : (
                  <Feather name="activity" size={20} color="#e8ff47" />
                )}
                <View style={{ flex: 1 }}>
                  <Text style={{ color: '#f0ede8', fontSize: 18, fontWeight: '700', fontFamily: 'BarlowCondensed_700Bold' }}>
                    HR Graph{hrCurve ? ' ✓' : ''}
                  </Text>
                  <Text style={{ color: '#8a877f', fontSize: 13 }}>Line graph showing heart rate over time</Text>
                </View>
                <Feather name="chevron-right" size={16} color="#8a877f" />
              </TouchableOpacity>

              {/* Analyze button */}
              {hasImage && (
                <TouchableOpacity
                  style={{ backgroundColor: '#e8ff47', borderRadius: 12, height: 56, alignItems: 'center', justifyContent: 'center', marginTop: 4 }}
                  onPress={analyze}
                >
                  <Text style={{ color: '#080808', fontSize: 18, fontWeight: '800', fontFamily: 'BarlowCondensed_700Bold' }}>
                    Analyze My Session
                  </Text>
                </TouchableOpacity>
              )}

              {/* Skip */}
              <TouchableOpacity style={{ alignItems: 'center', marginTop: 4 }} onPress={onSkip}>
                <Text style={{ color: '#8a877f', fontSize: 15, textDecorationLine: 'underline' }}>Skip for now</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Screen 3: Coaching Debrief ─────────────────────────────────────────────────

function HRDebriefScreen({ result, sessionLogId, userId, onDone }: {
  result: any;
  sessionLogId: string | null;
  userId: string | null;
  onDone: () => void;
}) {
  const navigation = useNavigation<Nav>();
  const analysis = result?.analysis ?? {};
  const zones    = result?.zones ?? {};
  const [flagSent, setFlagSent] = useState(false);

  async function handleReply() {
    const note = analysis.hr_coaching_notes ?? '';
    if (note) {
      await AsyncStorage.setItem('pending_coach_reply', note);
    }
    onDone();
    (navigation as any).navigate('Messages');
  }

  async function handleFlag() {
    if (flagSent) return;
    try {
      await fetch('https://peak65.vercel.app/api/ai-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          triggerType: 'flag_analysis',
          sessionData: { sessionLogId, note: 'Athlete flagged HR analysis as inaccurate' },
        }),
      });
    } catch {}
    setFlagSent(true);
  }

  const execQuality: string = analysis.execution_quality ?? 'unable_to_assess';

  const badgeConfig: Record<string, { color: string; icon: string; label: string }> = {
    excellent:         { color: '#00d4aa', icon: 'check-circle', label: 'TEXTBOOK SESSION' },
    good:              { color: '#00d4aa', icon: 'check',        label: 'SOLID WORK' },
    slightly_overdone: { color: '#e8ff47', icon: 'alert-triangle', label: 'PUSHED THE LINE' },
    overdone:          { color: '#ff3b3b', icon: 'alert-circle', label: 'LEFT IT ALL OUT THERE' },
    underdone:         { color: '#8a877f', icon: 'minus-circle', label: 'MORE IN THE TANK' },
    unable_to_assess:  { color: '#8a877f', icon: 'help-circle', label: 'SESSION LOGGED' },
  };
  const badge = badgeConfig[execQuality] ?? badgeConfig.unable_to_assess;

  const coachingFlagMap: Record<string, string> = {
    went_too_hard:            'You pushed above prescribed intensity. Check how your legs feel tomorrow morning before deciding whether to go full gas on the next session.',
    stayed_too_easy:          "The data shows you stayed below prescribed intensity. Not every session needs to be maximal — but if you felt held back, trust the zone next time.",
    poor_interval_recovery:   'Your HR stayed elevated between intervals. Take the full prescribed rest periods — the recovery is where the adaptation happens.',
    zone2_drift_second_half:  'HR crept into higher zones in the second half. Slow down earlier to hold Zone 2 properly — the pace will feel frustratingly slow at first.',
    hr_never_dropped_in_rest: "HR didn't drop during rest periods. Your body is carrying more fatigue than today's session alone explains. Watch tomorrow morning's readiness.",
    excellent_execution:      'That is exactly what we programmed. Clean execution builds clean fitness — this is how you get faster.',
    improving_fitness:        'Your recovery rate is trending up. The training is working. Keep showing up like this.',
  };

  // Zone bar
  const zoneColors: Record<string, string> = {
    z1: '#444444', z2: 'rgba(0,212,170,0.4)', z3: 'rgba(232,255,71,0.6)', z4: '#e8ff47', z5: '#ff3b3b',
  };
  const zoneEntries = (['z1','z2','z3','z4','z5'] as const).map(k => ({ key: k, mins: (zones[k] ?? 0) as number })).filter(z => z.mins > 0);
  const totalZoneMins = zoneEntries.reduce((sum, z) => sum + z.mins, 0);
  const topZone = zoneEntries.length > 0 ? zoneEntries.reduce((a, b) => a.mins > b.mins ? a : b) : null;

  // Top zone color
  const topZoneColor = topZone
    ? (topZone.key === 'z4' || topZone.key === 'z5' ? '#00d4aa' : topZone.key === 'z3' ? '#e8ff47' : '#8a877f')
    : '#8a877f';

  const hrr = analysis.hr_recovery_1min as number | null;
  const hrrColor = hrr == null ? '#8a877f' : hrr >= 25 ? '#00d4aa' : hrr >= 18 ? '#e8ff47' : '#ff3b3b';
  const peakHr = analysis.peak_hr as number | null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#080808' }} edges={['top', 'bottom']}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} showsVerticalScrollIndicator={false}>

        {/* Execution badge */}
        <View style={{ alignItems: 'center', paddingTop: 48 }}>
          <Feather name={badge.icon as any} size={48} color={badge.color} />
          <Text style={{ color: badge.color, fontSize: 13, fontWeight: '700', letterSpacing: 2, marginTop: 8, fontFamily: 'BarlowCondensed_700Bold' }}>
            {badge.label}
          </Text>
        </View>

        {/* Coaching card */}
        <View style={{ backgroundColor: '#111111', borderRadius: 12, margin: 16, padding: 24 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Feather name="message-square" size={18} color="#e8ff47" />
              <Text style={{ color: '#e8ff47', fontSize: 13, fontWeight: '700', letterSpacing: 1, fontFamily: 'BarlowCondensed_700Bold' }}>FROM YOUR COACH</Text>
            </View>
            <Text style={{ color: '#8a877f', fontSize: 12 }}>Just now</Text>
          </View>
          <Text style={{ color: '#f0ede8', fontSize: 17, lineHeight: 28, marginTop: 12 }}>
            {analysis.hr_coaching_notes ?? 'Your session has been logged.'}
          </Text>
          <TouchableOpacity
            style={{ backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#e8ff47', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16 }}
            onPress={handleReply}
          >
            <Feather name="message-circle" size={16} color="#e8ff47" />
            <Text style={{ color: '#e8ff47', fontSize: 15, fontWeight: '700', fontFamily: 'BarlowCondensed_700Bold' }}>Reply to your coach</Text>
          </TouchableOpacity>
        </View>

        {/* Stats row */}
        <View style={{ flexDirection: 'row', marginHorizontal: 16, gap: 8 }}>
          {/* Top zone */}
          <View style={{ flex: 1, backgroundColor: '#111111', borderRadius: 10, padding: 14 }}>
            <Text style={{ color: '#8a877f', fontSize: 11, letterSpacing: 1 }}>TOP ZONE</Text>
            <Text style={{ color: topZoneColor, fontSize: 26, fontWeight: '800', fontFamily: 'BarlowCondensed_700Bold', marginTop: 4 }}>
              {topZone ? topZone.key.toUpperCase() : '--'}
            </Text>
            <Text style={{ color: '#8a877f', fontSize: 11, marginTop: 2 }}>
              {topZone ? `${Math.round(topZone.mins)} min` : 'No data'}
            </Text>
          </View>
          {/* HRR */}
          <View style={{ flex: 1, backgroundColor: '#111111', borderRadius: 10, padding: 14 }}>
            <Text style={{ color: '#8a877f', fontSize: 11, letterSpacing: 1 }}>1-MIN RECOVERY</Text>
            <Text style={{ color: hrr != null ? hrrColor : '#8a877f', fontSize: 26, fontWeight: '800', fontFamily: 'BarlowCondensed_700Bold', marginTop: 4 }}>
              {hrr != null ? `${hrr}` : '--'}
            </Text>
            <Text style={{ color: '#8a877f', fontSize: 11, marginTop: 2 }}>
              {hrr != null ? 'bpm' : 'Upload HR graph to unlock'}
            </Text>
          </View>
          {/* Peak HR */}
          <View style={{ flex: 1, backgroundColor: '#111111', borderRadius: 10, padding: 14 }}>
            <Text style={{ color: '#8a877f', fontSize: 11, letterSpacing: 1 }}>PEAK HR</Text>
            <Text style={{ color: '#f0ede8', fontSize: 26, fontWeight: '800', fontFamily: 'BarlowCondensed_700Bold', marginTop: 4 }}>
              {peakHr != null ? `${peakHr}` : '--'}
            </Text>
            <Text style={{ color: '#8a877f', fontSize: 11, marginTop: 2 }}>bpm</Text>
          </View>
        </View>

        {/* Zone breakdown bar */}
        {zoneEntries.length > 0 && (
          <View style={{ backgroundColor: '#111111', borderRadius: 12, margin: 16, padding: 20 }}>
            <Text style={{ color: '#8a877f', fontSize: 12, letterSpacing: 1 }}>TIME IN ZONES</Text>
            <View style={{ flexDirection: 'row', height: 12, borderRadius: 6, overflow: 'hidden', marginTop: 12 }}>
              {zoneEntries.map(z => (
                <View key={z.key} style={{ flex: z.mins / totalZoneMins, backgroundColor: zoneColors[z.key] }} />
              ))}
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 10 }}>
              {zoneEntries.map(z => (
                <View key={z.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: zoneColors[z.key] }} />
                  <Text style={{ color: '#8a877f', fontSize: 12 }}>{z.key.toUpperCase()} · {Math.round(z.mins)} min</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Coaching flag */}
        {analysis.coaching_flag && coachingFlagMap[analysis.coaching_flag] && (
          <View style={{ backgroundColor: '#1a1a1a', borderRadius: 10, borderLeftWidth: 3, borderLeftColor: '#e8ff47', marginHorizontal: 16, padding: 14, flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
            <Feather name="info" size={16} color="#e8ff47" style={{ marginTop: 2 }} />
            <Text style={{ color: '#f0ede8', fontSize: 14, lineHeight: 22, flex: 1 }}>
              {coachingFlagMap[analysis.coaching_flag]}
            </Text>
          </View>
        )}

        {/* Flag button */}
        <TouchableOpacity
          style={{ backgroundColor: '#1a1a1a', borderRadius: 8, marginHorizontal: 16, marginTop: 16, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }}
          onPress={handleFlag}
          disabled={flagSent}
        >
          <Feather name="flag" size={14} color={flagSent ? '#00d4aa' : '#8a877f'} />
          <Text style={{ color: flagSent ? '#00d4aa' : '#8a877f', fontSize: 13 }}>
            {flagSent ? 'Flagged for review — thanks' : "This doesn't look right — flag for review"}
          </Text>
        </TouchableOpacity>

        {/* Done button */}
        <TouchableOpacity
          style={{ backgroundColor: '#e8ff47', borderRadius: 12, height: 56, alignItems: 'center', justifyContent: 'center', margin: 16, marginTop: 16, marginBottom: 32 }}
          onPress={onDone}
        >
          <Text style={{ color: '#080808', fontSize: 18, fontWeight: '800', fontFamily: 'BarlowCondensed_700Bold' }}>Done</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Screen 4: Invalid Image ────────────────────────────────────────────────────

function HRInvalidScreen({ onRetry, onSkip }: { onRetry: () => void; onSkip: () => void }) {
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#080808' }} edges={['top', 'bottom']}>
      <StatusBar barStyle="light-content" />
      <View style={{ flex: 1, alignItems: 'center', paddingHorizontal: 32, paddingTop: 80 }}>
        <Feather name="x-circle" size={48} color="#ff3b3b" />
        <Text style={{ color: '#f0ede8', fontSize: 30, fontWeight: '800', textAlign: 'center', marginTop: 16, fontFamily: 'BarlowCondensed_700Bold' }}>
          We couldn't read that
        </Text>
        <Text style={{ color: '#8a877f', fontSize: 16, textAlign: 'center', maxWidth: 300, marginTop: 8, lineHeight: 26 }}>
          We need an actual heart rate graph — either the zone breakdown chart or the HR line over time. A text summary or number list won't work. Go back to your app and screenshot the graph.
        </Text>
        <View style={{ width: '100%', gap: 12, marginTop: 32 }}>
          <TouchableOpacity
            style={{ backgroundColor: '#e8ff47', borderRadius: 12, height: 56, alignItems: 'center', justifyContent: 'center' }}
            onPress={onRetry}
          >
            <Text style={{ color: '#080808', fontSize: 18, fontWeight: '800', fontFamily: 'BarlowCondensed_700Bold' }}>Try Again</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={{ borderRadius: 12, height: 56, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#8a877f' }}
            onPress={onSkip}
          >
            <Text style={{ color: '#8a877f', fontSize: 18, fontWeight: '700', fontFamily: 'BarlowCondensed_700Bold' }}>Skip for now</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

// ── Screen 5: Network Error ────────────────────────────────────────────────────

function HRNetworkErrorScreen({ onDone }: { onDone: () => void }) {
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#080808' }} edges={['top', 'bottom']}>
      <StatusBar barStyle="light-content" />
      <View style={{ flex: 1, alignItems: 'center', paddingHorizontal: 32, paddingTop: 80 }}>
        <Feather name="wifi-off" size={48} color="#8a877f" />
        <Text style={{ color: '#f0ede8', fontSize: 30, fontWeight: '800', textAlign: 'center', marginTop: 16, fontFamily: 'BarlowCondensed_700Bold' }}>
          Couldn't connect
        </Text>
        <Text style={{ color: '#8a877f', fontSize: 16, textAlign: 'center', maxWidth: 300, marginTop: 8, lineHeight: 26 }}>
          Your session is saved. The HR analysis didn't go through — you can try again from your session history when you have a connection.
        </Text>
        <TouchableOpacity
          style={{ backgroundColor: '#e8ff47', borderRadius: 12, height: 56, alignItems: 'center', justifyContent: 'center', width: '100%', marginTop: 32 }}
          onPress={onDone}
        >
          <Text style={{ color: '#080808', fontSize: 18, fontWeight: '800', fontFamily: 'BarlowCondensed_700Bold' }}>Done</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

// ─── Shared styles ────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#080808' },
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
  rpeDot:   { width: 44, height: 44, borderRadius: 22, backgroundColor: Colors.nested, alignItems: 'center', justifyContent: 'center' },
  rpeDotOn: { backgroundColor: Colors.accent },
  rpeTxt:   { color: Colors.textSecondary, fontSize: 14, fontWeight: '700' },
  rpeTxtOn: { color: Colors.background },
  rpeDesc:  { color: Colors.textSecondary, fontSize: 13, textAlign: 'center', marginBottom: 40 },

  nextCard:      { marginHorizontal: 16, marginBottom: 8, backgroundColor: '#111111', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
  nextCardLabel: { color: '#8a877f', fontSize: 10, fontWeight: '700', letterSpacing: 1.5 },
  nextCardName:  { color: '#f0ede8', fontSize: 14, fontWeight: '600', flex: 1 },
});
