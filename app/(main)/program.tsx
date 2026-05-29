import React, { useState, useEffect, useCallback, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, RefreshControl,
  StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import type { Program, ProgramDay, ProgramSession, ExerciseItem, MainStackParamList } from '../_layout';
import {
  matchTimeTrial, getWorkoutHRDetail,
  type WorkoutSample,
} from '../../lib/healthKit';
import { deriveZonesFromTimeTrial, type TrainingZones } from '../../lib/zoneDerivation';
import { Colors, Fonts } from '../../lib/theme';

type TimeTrialProfile = {
  goal: string | null;
  age: number | null;
  preferred_units: string | null;
  current_training_days: string | null;
  rest_days: number | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isSwappableRun(name: string): boolean {
  if (!/run/i.test(name)) return false;
  const lower = name.toLowerCase();
  return !['sled', 'farmers carry', 'sandbag', 'wall ball', 'burpee broad jump'].some(h => lower.includes(h));
}

function applySwapName(name: string, swap: 'ski' | 'row'): string {
  const to = swap === 'ski' ? 'Ski Erg' : 'Row Erg';
  return name.replace(/\brunning\b/gi, to).replace(/\brun\b/gi, to);
}

function isStrengthSession(session: ProgramSession): boolean {
  const names = (session.blocks ?? [])
    .flatMap(b => b.exercises ?? [])
    .map(e => e.name.toLowerCase());

  const byField = !!(
    session.log_field?.toLowerCase().includes('strength') ||
    session.log_field?.toLowerCase().includes('3rm')
  );
  const byLabel = !!(
    session.log_label?.toLowerCase().includes('3rm') ||
    session.log_label?.toLowerCase().includes('strength')
  );
  const STRENGTH_KW = ['squat', 'bench', 'deadlift', 'overhead', 'ohp', 'strict press'];
  const matchCount  = STRENGTH_KW.filter(kw => names.some(n => n.includes(kw))).length;
  const byExercises = matchCount >= 2;

  const result = byField || byLabel || byExercises;
  console.log('[isStrengthSession]', session.name, {
    log_field: session.log_field,
    log_label: session.log_label,
    exerciseNames: names,
    byField, byLabel, matchCount, result,
  });
  return result;
}

type ExGroup =
  | { kind: 'single'; ex: ExerciseItem; origIdx: number }
  | { kind: 'superset'; members: { ex: ExerciseItem; origIdx: number }[] }
  | { kind: 'circuit'; members: { ex: ExerciseItem; origIdx: number }[]; rounds: number; rest: string | null }
  | { kind: 'block'; blockName: string; members: { ex: ExerciseItem; origIdx: number }[] }
  | { kind: 'part-circuit'; blockName: string; members: { ex: ExerciseItem; origIdx: number }[]; rounds: number; rest: string | null }
  | { kind: 'part-superset'; blockName: string; members: { ex: ExerciseItem; origIdx: number }[] };

function groupBySuperset(exercises: ExerciseItem[]): ExGroup[] {
  const groups: ExGroup[] = [];
  let i = 0;
  while (i < exercises.length) {
    const ex = exercises[i];
    if (ex.block_id) {
      const bId = ex.block_id;
      const blockName = ex.block_name ?? '';
      const members: { ex: ExerciseItem; origIdx: number }[] = [];
      while (i < exercises.length && exercises[i].block_id === bId) {
        members.push({ ex: exercises[i], origIdx: i });
        i++;
      }
      const firstCircuitId = members[0].ex.circuit_id;
      if (firstCircuitId && members.every((m) => m.ex.circuit_id === firstCircuitId)) {
        groups.push({ kind: 'part-circuit', blockName, members, rounds: members[0].ex.circuit_rounds ?? 4, rest: members[0].ex.circuit_rest ?? null });
      } else {
        const firstSupersetId = members[0].ex.superset_id;
        if (firstSupersetId && members.every((m) => m.ex.superset_id === firstSupersetId)) {
          groups.push({ kind: 'part-superset', blockName, members });
        } else {
          groups.push({ kind: 'block', blockName, members });
        }
      }
    } else if (ex.circuit_id) {
      const cId = ex.circuit_id;
      const members: { ex: ExerciseItem; origIdx: number }[] = [];
      while (i < exercises.length && exercises[i].circuit_id === cId) {
        members.push({ ex: exercises[i], origIdx: i });
        i++;
      }
      if (members.length === 1) {
        groups.push({ kind: 'single', ex: members[0].ex, origIdx: members[0].origIdx });
      } else {
        groups.push({
          kind: 'circuit',
          members,
          rounds: members[0].ex.circuit_rounds ?? 4,
          rest: members[0].ex.circuit_rest ?? null,
        });
      }
    } else if (ex.superset_id) {
      const ssId = ex.superset_id;
      const members: { ex: ExerciseItem; origIdx: number }[] = [];
      while (i < exercises.length && exercises[i].superset_id === ssId) {
        members.push({ ex: exercises[i], origIdx: i });
        i++;
      }
      if (members.length === 1) {
        groups.push({ kind: 'single', ex: members[0].ex, origIdx: members[0].origIdx });
      } else {
        groups.push({ kind: 'superset', members });
      }
    } else {
      groups.push({ kind: 'single', ex, origIdx: i });
      i++;
    }
  }
  return groups;
}

// ─── Session document (flat text view) ───────────────────────────────────────

function SessionDocument({ session }: { session: ProgramSession }) {
  const blocks = session.blocks ?? [];

  function renderExerciseLine(ex: ExerciseItem, index: number, prefix?: string): React.ReactNode {
    const name = prefix ? `${prefix} ${ex.name}` : ex.name;
    const duration = (ex as any).duration as string | undefined;
    const type = (ex as any).type as string | undefined;
    const loadNote = (ex as any).load_note as string | undefined;
    const note = ex.notes || (ex as any).note as string | undefined;
    const firstSentence = note
      ? (note.split(/[.!?]/)[0]?.trim() ?? '').slice(0, 60)
      : '';

    const parts: string[] = [];

    if (type === 'strength' && ex.sets && ex.reps && Number(ex.sets) > 1) {
      parts.push(`${ex.sets}×${ex.reps}`);
    } else if (type === 'cardio' && duration && ex.sets && Number(ex.sets) > 1) {
      parts.push(`${ex.sets}×${duration}`);
    } else if (type === 'cardio' && duration) {
      parts.push(duration);
    } else if (type === 'z2_cardio' && duration) {
      parts.push(duration);
    } else if (ex.reps && ex.reps !== '1') {
      parts.push(String(ex.reps));
    }

    if (ex.rest && !['none','0 min','0:00','0','00:00'].includes(ex.rest.trim())) {
      parts.push(`${ex.rest} rest`);
    }

    if (firstSentence) parts.push(firstSentence);

    const detail = parts.join(' · ');

    return (
      <Text key={`ex-${index}-${prefix ?? ''}`} style={pd.exerciseLine}>
        <Text style={pd.exerciseName}>{name}</Text>
        {detail ? <Text style={pd.exerciseDetail}>{'  '}{detail}</Text> : null}
      </Text>
    );
  }

  function renderBlock(block: { block_name: string; exercises?: ExerciseItem[] }, bi: number): React.ReactNode {
    const exercises = block.exercises ?? [];
    const groups = groupBySuperset(exercises);

    return (
      <View key={bi} style={pd.blockSection}>
        <Text style={pd.blockLabel}>{block.block_name}</Text>
        {groups.map((group, gi) => {
          if (group.kind === 'circuit' || group.kind === 'part-circuit') {
            const members = group.members;
            const rounds = group.kind === 'circuit' ? group.rounds : group.rounds;
            const rest = group.kind === 'circuit' ? group.rest : group.rest;
            return (
              <View key={gi} style={pd.circuitSection}>
                {(() => { const timeCap = members[0]?.ex && (members[0].ex as any).time_cap; return (
                  <Text style={pd.circuitRounds}>{timeCap ? `${timeCap} AMRAP:` : `${rounds} Rounds:`}</Text>
                ); })()}
                {members.map(({ ex }, mi) => renderExerciseLine(ex, mi, undefined))}
                {!!rest && (
                  <Text style={pd.exerciseDetail}>{'  '}{rest} rest between rounds</Text>
                )}
              </View>
            );
          }
          if (group.kind === 'superset' || group.kind === 'part-superset') {
            const members = group.members;
            return (
              <View key={gi}>
                {members.map(({ ex }, mi) => {
                  const letter = String.fromCharCode(65 + mi);
                  const setNum = Math.floor(gi) + 1;
                  const prefix = `${setNum}${letter})`;
                  return renderExerciseLine(ex, mi, prefix);
                })}
              </View>
            );
          }
          if (group.kind === 'block') {
            return (
              <View key={gi}>
                <Text style={pd.subBlockLabel}>{group.blockName}</Text>
                {group.members.map(({ ex }, mi) => renderExerciseLine(ex, mi))}
              </View>
            );
          }
          // single
          return renderExerciseLine(group.ex, gi);
        })}
      </View>
    );
  }

  return (
    <View style={pd.sessionDoc}>
      <View style={pd.sessionHeader}>
        <Text style={pd.sessionName}>{session.name}</Text>
        <Text style={pd.sessionMeta}>
          {[session.time, session.duration_minutes ? `${session.duration_minutes} min` : null]
            .filter(Boolean).join(' · ')}
        </Text>
      </View>
      {!!session.description && (
        <Text style={pd.sessionDesc}>{session.description}</Text>
      )}
      {blocks.map((block, bi) => renderBlock(block, bi))}
    </View>
  );
}

const pd = StyleSheet.create({
  sessionDoc: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
    marginBottom: 4,
  },
  sessionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  sessionName: {
    color: '#f0ede8',
    fontSize: 17,
    fontWeight: '700',
    flex: 1,
    paddingRight: 8,
  },
  sessionMeta: {
    color: '#8a877f',
    fontSize: 13,
  },
  sessionDesc: {
    color: '#8a877f',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 16,
  },
  blockSection: {
    marginBottom: 12,
  },
  blockLabel: {
    color: '#e8ff47',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: 10,
    marginTop: 12,
    textAlign: 'center',
  },
  subBlockLabel: {
    color: '#e8ff47',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: 8,
    marginTop: 10,
    textAlign: 'center',
  },
  exerciseLine: {
    color: '#f0ede8',
    fontSize: 15,
    lineHeight: 24,
    marginBottom: 2,
  },
  exerciseName: {
    color: '#f0ede8',
    fontSize: 15,
    fontWeight: '600',
  },
  exerciseDetail: {
    color: '#8a877f',
    fontSize: 14,
  },
  circuitSection: {
    marginBottom: 8,
  },
  circuitRounds: {
    color: '#f0ede8',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 4,
  },
  dayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  dayName: {
    color: '#f0ede8',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 1,
  },
  dayType: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2,
  },
  logBtn: {
    marginHorizontal: 20,
    marginTop: 16,
    marginBottom: 8,
    backgroundColor: Colors.accent,
    paddingVertical: 18,
    alignItems: 'center',
  },
  logBtnTxt: {
    color: Colors.background,
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 1,
  },
});

// ─── Single-value trial log card (e.g. 8K time) ──────────────────────────────

function TrialLogCard({
  label, value, saved, saving,
  onChange, onSave,
}: {
  label: string | undefined;
  value: string;
  saved: boolean;
  saving: boolean;
  onChange: (v: string) => void;
  onSave: () => void;
}) {
  return (
    <View style={styles.trialCard}>
      <Text style={styles.trialLabel}>{label}</Text>
      {saved ? (
        <View style={styles.trialSavedRow}>
          <Text style={styles.trialSavedValue}>{value || '—'}</Text>
          <Text style={styles.trialSavedBadge}>✓ Saved</Text>
        </View>
      ) : (
        <>
          <TextInput
            style={styles.trialInput}
            placeholder="e.g. 42:30"
            placeholderTextColor={Colors.textSecondary}
            value={value}
            onChangeText={onChange}
            selectionColor={Colors.accent}
            autoCorrect={false}
            autoCapitalize="none"
            keyboardType="numbers-and-punctuation"
          />
          <TouchableOpacity
            style={[styles.trialBtn, (!value.trim() || saving) && styles.trialBtnDisabled]}
            onPress={onSave}
            disabled={!value.trim() || saving}
          >
            <Text style={styles.trialBtnText}>{saving ? 'SAVING...' : 'LOG SESSION'}</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}

// ─── Mark-complete card (Z2 / cardio / regular sessions) ─────────────────────

function MarkCompleteCard({
  saved, saving, onSave,
}: {
  saved: boolean; saving: boolean; onSave: () => void;
}) {
  if (saved) {
    return (
      <View style={styles.completeConfirm}>
        <Text style={styles.completeConfirmText}>Logged. Good work.</Text>
      </View>
    );
  }
  return (
    <TouchableOpacity
      style={[styles.trialBtn, saving && styles.trialBtnDisabled]}
      onPress={onSave}
      disabled={saving}
    >
      <Text style={styles.trialBtnText}>{saving ? 'SAVING...' : 'LOG SESSION'}</Text>
    </TouchableOpacity>
  );
}

// ─── Day card ─────────────────────────────────────────────────────────────────

function DayCard({
  day, isToday, isComplete,
  userId, programId, weekNumber, savedTrials,
  profile,
}: {
  day: ProgramDay;
  isToday: boolean;
  isComplete: boolean;
  userId: string | null;
  programId: string;
  weekNumber: number;
  savedTrials: Set<string>;
  profile: TimeTrialProfile | null;
}) {
  const isRest = day.type === 'rest' || !day.sessions?.length;
  const [expanded, setExpanded] = React.useState(isToday);

  // ── Trial state (single-value sessions) ─────────────────────────────────────
  const [trialValues, setTrialValues] = useState<Record<number, string>>({});
  const [trialSaved, setTrialSaved]   = useState<Record<number, boolean>>(() => {
    const init: Record<number, boolean> = {};
    (day.sessions ?? []).forEach((s, i) => {
      if (s.log_result && s.log_field && !isStrengthSession(s)) {
        init[i] = savedTrials.has(`${day.day}:${s.log_field}`);
      }
    });
    return init;
  });
  const [trialSaving, setTrialSaving] = useState(false);

  // ── Mark-complete state ──────────────────────────────────────────────────────
  const completeAlreadySaved = savedTrials.has(`${day.day}:session_complete`);
  const [completeSaved, setCompleteSaved]   = useState<Record<number, boolean>>(() => {
    const init: Record<number, boolean> = {};
    (day.sessions ?? []).forEach((s, i) => {
      if (!s.log_result && !isStrengthSession(s)) init[i] = completeAlreadySaved;
    });
    return init;
  });
  const [completeSaving, setCompleteSaving] = useState(false);

  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();

  // ── Time trial state ─────────────────────────────────────────────────────────
  const [ttStatus, setTtStatus]               = useState<'idle'|'matching'|'matched'|'multiple'|'notFound'|'zonesSet'>('idle');
  const [ttWorkouts, setTtWorkouts]           = useState<WorkoutSample[]>([]);
  const [ttModalVisible, setTtModalVisible]   = useState(false);
  const [ttManualDist, setTtManualDist]       = useState('');
  const [ttManualDuration, setTtManualDuration] = useState('');
  const [ttDeriving, setTtDeriving]           = useState(false);
  const [ttTrialType, setTtTrialType]         = useState<'hyrox_8k'|'gf_20min'|null>(null);

  async function upsertZones(zones: TrainingZones) {
    if (!userId) return;
    const { error } = await supabase.from('profiles').update({
      threshold_pace_per_km: zones.threshold_pace_per_km,
      easy_pace_per_km:      zones.easy_pace_per_km,
      tempo_pace_per_km:     zones.tempo_pace_per_km,
      threshold_hr:          zones.threshold_hr,
      z1_max_hr:             zones.z1_max_hr,
      z2_max_hr:             zones.z2_max_hr,
      z3_max_hr:             zones.z3_max_hr,
      z4_max_hr:             zones.z4_max_hr,
      zone_source:           zones.zone_source,
    }).eq('id', userId);
    if (error) console.log('[program] upsertZones error:', error.message);
  }

  async function deriveAndSaveZones(trialType: 'hyrox_8k'|'gf_20min', workout: WorkoutSample) {
    if (!userId || !profile?.age) return;
    setTtStatus('matched');
    const hrDetail = await getWorkoutHRDetail(workout.startDate, workout.endDate);
    const distKm   = workout.distanceKm ?? (trialType === 'hyrox_8k' ? 8.0 : 4.0);
    const zones    = deriveZonesFromTimeTrial({
      trialType,
      durationSeconds:   workout.durationSeconds,
      distanceKm:        distKm,
      avgHRLastPortion:  hrDetail.avgHRLastPortion,
      userAge:           profile.age,
    });
    await upsertZones(zones);
    setTtStatus('zonesSet');
  }

  async function handleTimeTrialMatch(trialType: 'hyrox_8k'|'gf_20min') {
    setTtTrialType(trialType);
    setTtStatus('matching');
    const today  = new Date().toISOString().split('T')[0];
    const result = await matchTimeTrial({ trialType, date: today });
    if (result.notFound) {
      setTtStatus('notFound');
    } else if (result.needsConfirmation) {
      setTtWorkouts(result.workouts);
      setTtStatus('multiple');
      setTtModalVisible(true);
    } else {
      await deriveAndSaveZones(trialType, result.workout!);
    }
  }

  async function saveManualZones(trialType: 'hyrox_8k'|'gf_20min') {
    if (!profile?.age) return;
    setTtDeriving(true);
    const useMetric = profile.preferred_units !== 'imperial';
    let distKm      = parseFloat(ttManualDist);
    if (!useMetric) distKm = distKm * 1.60934;

    const parts = ttManualDuration.split(':').map(Number);
    let secs = 0;
    if (parts.length === 2) secs = (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
    else if (parts.length === 3) secs = (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);

    if (!distKm || distKm <= 0 || !secs || secs <= 0) { setTtDeriving(false); return; }

    const zones = deriveZonesFromTimeTrial({
      trialType,
      durationSeconds:  secs,
      distanceKm:       distKm,
      avgHRLastPortion: null,
      userAge:          profile.age,
    });
    await upsertZones(zones);
    setTtDeriving(false);
    setTtStatus('zonesSet');
  }

  async function saveTrialResult(si: number, session: ProgramSession) {
    if (!userId || !trialValues[si]?.trim()) return;
    setTrialSaving(true);
    const { error } = await supabase.from('session_logs').insert({
      user_id:      userId,
      program_id:   programId,
      day_name:     day.day,
      week_number:  weekNumber,
      session_name: session.name,
      log_field:    session.log_field ?? null,
      log_value:    trialValues[si].trim(),
      completed:    true,
      completed_at: new Date().toISOString(),
    });
    if (error) console.log('[program] saveTrialResult error:', error.message);

    // Hard 3 detection — triggers next week program generation
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

        const { data: profileData } = await supabase
          .from('profiles')
          .select('timezone, tier')
          .eq('id', userId)
          .single();

        const athleteTimezone = (profileData?.timezone as string) || 'America/New_York';
        const todayDayName = new Date().toLocaleDateString('en-US', {
          weekday: 'long',
          timeZone: athleteTimezone,
        });

        const athleteTier = (profileData?.tier as string) || 'ai_coached';
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
      console.error('[saveTrialResult] Hard 3 detection error:', err);
    }

    setTrialSaved(prev => ({ ...prev, [si]: true }));
    setTrialSaving(false);

    // Trigger zone derivation only for the Week 1 run time trial, not conditioning
    const sessionIsRunTrial =
      session.name.toLowerCase().includes('run') ||
      session.name.toLowerCase().includes('time trial') ||
      (session.log_field ?? '').toLowerCase().includes('run');
    if (weekNumber === 1 && sessionIsRunTrial && profile?.goal && profile?.age) {
      const trialType: 'hyrox_8k'|'gf_20min' = profile.goal === 'hyrox' ? 'hyrox_8k' : 'gf_20min';
      const distanceKm = trialType === 'hyrox_8k' ? 8.0 : 5.0;

      // Derive zones immediately from the logged time so profile has paces
      // before HealthKit matching (which may not be available).
      const raw = trialValues[si].trim();
      const parts = raw.split(':').map(Number);
      let secs = 0;
      if (parts.length === 2) secs = (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
      else if (parts.length === 3) secs = (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
      if (secs > 0 && !parts.some(isNaN)) {
        const zones = deriveZonesFromTimeTrial({
          trialType,
          durationSeconds:   secs,
          distanceKm,
          avgHRLastPortion:  null,
          userAge:           profile.age,
        });
        await upsertZones(zones);
      }

      // Also try HealthKit match to refine with real HR data
      handleTimeTrialMatch(trialType);
    }

    // Week 2+: if athlete logs an 800m threshold split, derive zones from it
    const is800mSplit =
      (session.log_field ?? '').toLowerCase().includes('800') ||
      (session.log_field ?? '').toLowerCase().includes('threshold') ||
      session.name.toLowerCase().includes('threshold');
    if (weekNumber > 1 && is800mSplit && profile?.age) {
      const raw = trialValues[si].trim();
      const parts = raw.split(':').map(Number);
      let splitSecs = 0;
      if (parts.length === 2) splitSecs = (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
      if (splitSecs > 0 && !parts.some(isNaN)) {
        // 800m split at threshold = threshold_pace_per_km × 0.8
        const thresholdPacePerKm = splitSecs / 0.8;
        const trialType: 'hyrox_8k'|'gf_20min' = profile.goal === 'hyrox' ? 'hyrox_8k' : 'gf_20min';
        const zones = deriveZonesFromTimeTrial({
          trialType,
          durationSeconds:  thresholdPacePerKm * (trialType === 'hyrox_8k' ? 8.0 : 5.0),
          distanceKm:       trialType === 'hyrox_8k' ? 8.0 : 5.0,
          avgHRLastPortion: null,
          userAge:          profile.age,
        });
        await upsertZones(zones);
        console.log('[program] zones updated from 800m threshold split:', raw);
      }
    }
  }

  async function markSessionComplete(si: number, sessionName: string) {
    if (!userId) return;
    setCompleteSaving(true);
    const { error } = await supabase.from('session_logs').insert({
      user_id:      userId,
      program_id:   programId,
      day_name:     day.day,
      week_number:  weekNumber,
      session_name: sessionName,
      log_field:    'session_complete',
      completed:    true,
      completed_at: new Date().toISOString(),
    });
    if (error) console.log('[program] markSessionComplete error:', error.message);

    // Hard 3 detection — triggers next week program generation
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

        const { data: profileData } = await supabase
          .from('profiles')
          .select('timezone, tier')
          .eq('id', userId)
          .single();

        const athleteTimezone = (profileData?.timezone as string) || 'America/New_York';
        const todayDayName = new Date().toLocaleDateString('en-US', {
          weekday: 'long',
          timeZone: athleteTimezone,
        });

        const athleteTier = (profileData?.tier as string) || 'ai_coached';
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
      console.error('[markSessionComplete] Hard 3 detection error:', err);
    }

    setCompleteSaved(prev => ({ ...prev, [si]: true }));
    setCompleteSaving(false);
  }

  return (
    <>
    <View style={[styles.dayCard, isToday && styles.dayCardToday, { borderLeftWidth: isToday ? 2 : 0, borderLeftColor: '#e8ff47' }]}>
      <TouchableOpacity style={pd.dayHeader} onPress={() => setExpanded(e => !e)}>
        <Text style={pd.dayName}>{day.day.toUpperCase()}</Text>
        <Text style={[pd.dayType, {
          color: day.type === 'hard' ? '#e8ff47' : day.type === 'easy' ? '#00d4aa' : day.type === 'trial' ? '#e8ff47' : '#3a3a3a'
        }]}>
          {(day.type ?? 'rest').toUpperCase()}
        </Text>
        <Feather name={expanded ? 'chevron-up' : 'chevron-down'} color='#8a877f' size={16} />
      </TouchableOpacity>

      {expanded && !isRest && (day.sessions ?? []).map((session, si) => (
        <View key={si}>
          <SessionDocument session={session} />
          {(session.log_result !== false) && (isToday || !isComplete) && (
            <TouchableOpacity
              style={pd.logBtn}
              onPress={() => navigation.navigate('LogSession', {
                sessionJson: JSON.stringify(session),
                programId,
                weekNumber,
                dayName: day.day,
              })}
            >
              <Text style={pd.logBtnTxt}>LOG SESSION →</Text>
            </TouchableOpacity>
          )}
        </View>
      ))}
    </View>

    <Modal
      visible={ttModalVisible}
      transparent
      animationType="fade"
      onRequestClose={() => setTtModalVisible(false)}
    >
      <View style={styles.ttModalOverlay}>
        <View style={styles.ttModalCard}>
          <Text style={styles.ttModalTitle}>Which run was your time trial?</Text>
          {ttWorkouts.map((w, i) => (
            <TouchableOpacity
              key={i}
              style={styles.ttWorkoutOption}
              onPress={() => {
                setTtModalVisible(false);
                if (ttTrialType) deriveAndSaveZones(ttTrialType, w);
              }}
            >
              <Text style={styles.ttWorkoutTime}>
                {new Date(w.startDate).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
              </Text>
              <Text style={styles.ttWorkoutDetail}>
                {w.distanceKm != null ? `${w.distanceKm.toFixed(2)} km · ` : ''}{w.durationMinutes} min
              </Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            style={styles.ttModalSkipBtn}
            onPress={() => { setTtModalVisible(false); setTtStatus('notFound'); }}
          >
            <Text style={styles.ttModalSkipText}>Enter manually instead</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  </>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function ProgramScreen() {
  const [allPrograms, setAllPrograms]     = useState<Program[]>([]);
  const [weekIdx, setWeekIdx]             = useState(0);
  const [completedMap, setCompletedMap]   = useState<Record<number, Set<string>>>({});
  const [savedTrialMap, setSavedTrialMap] = useState<Record<number, Set<string>>>({});
  const [userId, setUserId]               = useState<string | null>(null);
  const [todayName, setTodayName]         = useState('');
  const [loading, setLoading]             = useState(true);
  const [ttProfile, setTtProfile]         = useState<TimeTrialProfile | null>(null);
  const scrollViewRef = useRef<ScrollView>(null);
  const dayListY      = useRef(0);
  const dayYOffsets   = useRef<Record<string, number>>({});
  const [refreshing, setRefreshing] = useState(false);

  const [activeProgram, setActiveProgram]       = useState<Program | null>(null);
  const [generatingNextWeek, setGeneratingNextWeek] = useState(false);
  const [nextWeekReady, setNextWeekReady]       = useState(false);
  const [nextWeekBannerDismissed, setNextWeekBannerDismissed] = useState(false);
  const nextWeekTriggeredRef = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem('dismissed_next_week_banner').then(val => {
      if (val === 'true') setNextWeekBannerDismissed(true);
    });
  }, []);

  async function checkAndGenerateNextWeek(uid: string, prog: Program, completedDayCount: number, trainingDaysCount: number) {
    if (nextWeekTriggeredRef.current) return;
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    const days  = prog.program_data?.days ?? [];
    const trainingDays = days.filter(d => d.type !== 'rest' && (d.sessions ?? []).length > 0);
    const isLastDay    = trainingDays.length > 0 && trainingDays[trainingDays.length - 1].day === today;

    if (completedDayCount < trainingDaysCount && !isLastDay) return;

    const nextNum = prog.week_number + 1;
    const { data: existing } = await supabase
      .from('programs').select('id').eq('user_id', uid).eq('week_number', nextNum).limit(1);
    if (existing?.length) { setNextWeekReady(true); return; }

    nextWeekTriggeredRef.current = true;
    setGeneratingNextWeek(true);
    try {
      const res = await fetch('https://peak65.vercel.app/api/generate-next-week', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: uid, currentWeekNumber: prog.week_number }),
      });
      if (res.ok) setNextWeekReady(true);
    } catch (e) {
      console.log('[program] generate-next-week error:', e);
      nextWeekTriggeredRef.current = false;
    }
    setGeneratingNextWeek(false);
  }

  const load = useCallback(async () => {
    // Apply program_cache immediately for instant render
    let cacheApplied = false;
    try {
      const raw = await AsyncStorage.getItem('program_cache');
      if (raw) {
        const c = JSON.parse(raw);
        if (Date.now() - (c.timestamp ?? 0) < 4 * 60 * 60 * 1000) {
          const progs = (c.programs ?? []) as Program[];
          setAllPrograms(progs);
          if (progs.length > 0) setWeekIdx(progs.length - 1);
          setTodayName(new Date().toLocaleDateString('en-US', { weekday: 'long' }));
          let active: Program | null = null;
          for (const p of progs) {
            const start = new Date(p.week_start_date + 'T00:00:00');
            const end   = new Date(start.getTime() + 7 * 86_400_000);
            if (new Date() >= start && new Date() < end) { active = p; break; }
          }
          if (!active && progs.length > 0) active = progs[progs.length - 1];
          setActiveProgram(active);
          const nextNum = active?.week_number ? active.week_number + 1 : null;
          const nextExists = nextNum ? progs.some(p => p.week_number === nextNum) : false;
          if (nextExists) setNextWeekReady(true);
          if (c.profile) {
            setTtProfile({
              goal:                  c.profile.goal ?? null,
              age:                   c.profile.age ?? null,
              preferred_units:       c.profile.preferred_units ?? null,
              current_training_days: c.profile.current_training_days ?? null,
              rest_days:             c.profile.rest_days ?? null,
            });
          }
          const cMap: Record<number, Set<string>> = {};
          const tMap: Record<number, Set<string>> = {};
          for (const log of c.sessionLogs ?? []) {
            if (!log.week_number || !log.day_name) continue;
            if (!cMap[log.week_number]) cMap[log.week_number] = new Set();
            cMap[log.week_number].add(log.day_name);
            if (log.log_field) {
              if (!tMap[log.week_number]) tMap[log.week_number] = new Set();
              tMap[log.week_number].add(`${log.day_name}:${log.log_field}`);
            }
          }
          setCompletedMap(cMap);
          setSavedTrialMap(tMap);
          setLoading(false);
          cacheApplied = true;
        }
      }
    } catch {}
    if (!cacheApplied) setLoading(true);

    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) { setLoading(false); return; }
    setUserId(session.user.id);

    const [progsRes, logsRes, profileRes] = await Promise.all([
      supabase
        .from('programs')
        .select('*')
        .eq('user_id', session.user.id)
        .order('week_number', { ascending: true }),
      supabase
        .from('session_logs')
        .select('week_number, day_name, log_field')
        .eq('user_id', session.user.id)
        .not('day_name', 'is', null),
      supabase
        .from('profiles')
        .select('goal, age, preferred_units, current_training_days, rest_days')
        .eq('id', session.user.id)
        .maybeSingle(),
    ]);

    const progs = (progsRes.data ?? []) as Program[];
    setAllPrograms(progs);
    if (progs.length > 0) setWeekIdx(progs.length - 1);
    setTodayName(new Date().toLocaleDateString('en-US', { weekday: 'long' }));

    // Track active program for next-week generation
    let active: Program | null = null;
    for (const p of progs) {
      const start = new Date(p.week_start_date + 'T00:00:00');
      const end   = new Date(start.getTime() + 7 * 86_400_000);
      if (new Date() >= start && new Date() < end) { active = p; break; }
    }
    if (!active && progs.length > 0) active = progs[progs.length - 1];
    setActiveProgram(active);

    const nextNum = active?.week_number ? active.week_number + 1 : null;
    const nextExists = nextNum ? progs.some(p => p.week_number === nextNum) : false;
    if (nextExists) setNextWeekReady(true);

    if (profileRes.data) {
      setTtProfile({
        goal:                  (profileRes.data as any).goal ?? null,
        age:                   (profileRes.data as any).age ?? null,
        preferred_units:       (profileRes.data as any).preferred_units ?? null,
        current_training_days: (profileRes.data as any).current_training_days ?? null,
        rest_days:             (profileRes.data as any).rest_days ?? null,
      });
    }

    const cMap: Record<number, Set<string>> = {};
    const tMap: Record<number, Set<string>> = {};
    for (const log of logsRes.data ?? []) {
      if (!log.week_number || !log.day_name) continue;
      if (!cMap[log.week_number]) cMap[log.week_number] = new Set();
      cMap[log.week_number].add(log.day_name);
      if (log.log_field) {
        if (!tMap[log.week_number]) tMap[log.week_number] = new Set();
        tMap[log.week_number].add(`${log.day_name}:${log.log_field}`);
      }
    }
    setCompletedMap(cMap);
    setSavedTrialMap(tMap);
    setLoading(false);

    // Check if we should generate next week on load
    if (active && !nextExists && !nextWeekTriggeredRef.current) {
      const activeCompletedCount = (cMap[active.week_number] ?? new Set()).size;
      const pd = profileRes.data as any;
      const trainingDaysCount = pd?.current_training_days != null
        ? (parseInt(pd.current_training_days, 10) || 5)
        : pd?.rest_days != null ? Math.max(1, 7 - pd.rest_days) : 5;
      checkAndGenerateNextWeek(session.user.id, active, activeCompletedCount, trainingDaysCount);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Scroll to today's card after loading completes using measured layout positions
  useEffect(() => {
    if (loading || !isViewingCurrentWeek) return;
    const todayIdx = days.findIndex(d => d.day === todayName);
    if (todayIdx < 0) return;
    setTimeout(() => {
      const cardY = dayYOffsets.current[todayName] ?? 0;
      const offset = Math.max(0, dayListY.current + cardY - 20);
      scrollViewRef.current?.scrollTo({ y: offset, animated: true });
    }, 400);
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <ActivityIndicator color={Colors.accent} style={{ flex: 1 }} />
      </SafeAreaView>
    );
  }

  const currentProgram = allPrograms[weekIdx] ?? null;
  const days           = currentProgram?.program_data?.days ?? [];
  const displayWeekNum = currentProgram?.week_number ?? weekIdx + 1;
  const completedDays  = completedMap[displayWeekNum] ?? new Set<string>();
  const savedTrials    = savedTrialMap[displayWeekNum] ?? new Set<string>();

  const canGoBack    = weekIdx > 0;
  const canGoForward = weekIdx < allPrograms.length - 1;

  const isViewingCurrentWeek = (() => {
    if (!currentProgram?.week_start_date) return false;
    const start = new Date(currentProgram.week_start_date + 'T00:00:00');
    const end   = new Date(start.getTime() + 7 * 86_400_000);
    return new Date() >= start && new Date() < end;
  })();

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          ref={scrollViewRef}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 60 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />}
        >
          <Text style={styles.heading}>MY PROGRAM</Text>

          {generatingNextWeek && (
            <View style={styles.nextWeekBanner}>
              <ActivityIndicator size="small" color={Colors.accent} style={{ marginRight: 10 }} />
              <View>
                <Text style={styles.nextWeekTitle}>Preparing your next week...</Text>
                <Text style={styles.nextWeekSub}>Your coach is reviewing your session data.</Text>
              </View>
            </View>
          )}
          {nextWeekReady && !generatingNextWeek && !nextWeekBannerDismissed && activeProgram && allPrograms.some(p => p.week_number === activeProgram.week_number + 1) && (
            <TouchableOpacity
              style={[styles.nextWeekBanner, styles.nextWeekBannerReady]}
              onPress={() => {
                AsyncStorage.setItem('dismissed_next_week_banner', 'true');
                setNextWeekBannerDismissed(true);
              }}
              activeOpacity={0.8}
            >
              <Feather name="calendar" color={Colors.accent} size={22} style={{ marginRight: 12 }} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.nextWeekTitle, { color: Colors.accent }]}>
                  Week {activeProgram.week_number + 1} is ready.
                </Text>
                <Text style={styles.nextWeekSub}>Tap the arrows above to view it.</Text>
              </View>
              <Feather name="x" color="#8a877f" size={16} />
            </TouchableOpacity>
          )}

          <View style={styles.weekRow}>
            <TouchableOpacity
              onPress={() => setWeekIdx(i => i - 1)}
              disabled={!canGoBack}
              style={styles.weekArrow}
            >
              <Feather name="chevron-left" color={!canGoBack ? '#333' : Colors.textPrimary} size={28} />
            </TouchableOpacity>
            <Text style={styles.weekLabel}>Week {displayWeekNum}</Text>
            <TouchableOpacity
              onPress={() => setWeekIdx(i => i + 1)}
              disabled={!canGoForward}
              style={styles.weekArrow}
            >
              <Feather name="chevron-right" color={!canGoForward ? '#333' : Colors.textPrimary} size={28} />
            </TouchableOpacity>
          </View>

          {allPrograms.length === 0 ? (
            <Text style={styles.emptyText}>No program found.</Text>
          ) : days.length === 0 ? (
            <Text style={styles.emptyText}>No days in this week.</Text>
          ) : (
            <View
              style={styles.dayList}
              onLayout={e => { dayListY.current = e.nativeEvent.layout.y; }}
            >
              {days.map(day => (
                <View
                  key={day.day}
                  onLayout={e => { dayYOffsets.current[day.day] = e.nativeEvent.layout.y; }}
                >
                  <DayCard
                    day={day}
                    isToday={isViewingCurrentWeek && day.day === todayName}
                    isComplete={completedDays.has(day.day)}
                    userId={userId}
                    programId={currentProgram?.id ?? ''}
                    weekNumber={displayWeekNum}
                    savedTrials={savedTrials}
                    profile={ttProfile}
                  />
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  heading: {
    color: Colors.textPrimary, fontSize: 24, fontWeight: '800',
    paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8,
  },

  nextWeekBanner: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: 16, marginBottom: 8,
    backgroundColor: Colors.card, borderRadius: 14, padding: 16,
  },
  nextWeekBannerReady: { borderLeftWidth: 3, borderLeftColor: Colors.green },
  nextWeekTitle: { color: Colors.textPrimary, fontSize: 14, fontWeight: '700' },
  nextWeekSub:   { color: Colors.textSecondary, fontSize: 12, marginTop: 2 },

  weekRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 24, paddingVertical: 12,
  },
  weekArrow: { padding: 8 },
  weekLabel: { color: Colors.textPrimary, fontSize: 17, fontWeight: '700', minWidth: 80, textAlign: 'center' },

  dayList:      { paddingHorizontal: 16, gap: 10 },
  dayCard:      { backgroundColor: Colors.card, borderRadius: 14, overflow: 'hidden' },
  dayCardToday: { borderLeftWidth: 3, borderLeftColor: Colors.accent },

  dayName:      { color: Colors.textPrimary, fontSize: 15, fontWeight: '700' },

  // Run swap button
  swapBtn:    { borderWidth: 1, borderColor: '#333', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  swapBtnTxt: { color: '#8a877f', fontSize: 12 },

  // Run swap sheet
  swapSheet:            { backgroundColor: Colors.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, gap: 12 },
  swapSheetTitle:       { color: Colors.textPrimary, fontSize: 13, fontWeight: '700', letterSpacing: 2, marginBottom: 4 },
  swapOption:           { borderWidth: 1, borderColor: '#333', borderRadius: 12, paddingVertical: 16, paddingHorizontal: 20, alignItems: 'center' as const },
  swapOptionSelected:   { borderColor: Colors.accent },
  swapOptionText:       { color: Colors.textPrimary, fontSize: 15, fontWeight: '600' },
  swapOptionTextSelected: { color: Colors.accent },
  swapCancelBtn:        { alignItems: 'center' as const, paddingVertical: 12, marginTop: 4 },
  swapCancelText:       { color: Colors.textSecondary, fontSize: 14 },

  // Trial / cardio log
  trialCard: {
    backgroundColor: Colors.nested, borderRadius: 10, padding: 14, gap: 10,
    borderLeftWidth: 3, borderLeftColor: Colors.accent,
  },
  trialLabel:      { color: Colors.textPrimary, fontSize: 13, fontWeight: '600' },
  trialInput:      {
    backgroundColor: Colors.card, borderWidth: 1, borderColor: Colors.border,
    borderRadius: 8, paddingHorizontal: 14, paddingVertical: 12,
    color: Colors.textPrimary, fontFamily: Fonts.metric, fontSize: 18,
  },
  trialBtn:        { backgroundColor: Colors.accent, borderRadius: 8, paddingVertical: 13, alignItems: 'center' },
  trialBtnDisabled:{ opacity: 0.45 },
  trialBtnText:    { color: Colors.background, fontSize: 14, fontWeight: '700' },

  trialSavedRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  trialSavedValue: { color: Colors.accent, fontFamily: Fonts.metric, fontSize: 20 },
  trialSavedBadge: { color: Colors.green, fontSize: 12, fontWeight: '700' },

  completeConfirm:     { paddingVertical: 8, alignItems: 'center' },
  completeConfirmText: { color: Colors.accent, fontSize: 14, fontWeight: '600' },

  restNote:  { color: Colors.textSecondary, fontSize: 14, fontStyle: 'italic' },
  emptyText: { color: Colors.textSecondary, textAlign: 'center', marginTop: 40, fontSize: 15 },

  // Time trial zone derivation
  ttStatusCard: {
    backgroundColor: Colors.nested, borderRadius: 10, padding: 14,
    borderLeftWidth: 3, borderLeftColor: Colors.green, gap: 10,
  },
  ttRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  ttStatusText: { color: Colors.textSecondary, fontSize: 13, flex: 1 },
  ttSuccessText: { color: Colors.green, fontSize: 13, fontWeight: '700' },
  ttManualEntry: { gap: 10 },
  ttManualRow:   { flexDirection: 'row', gap: 10 },
  ttManualInput: {
    flex: 1, backgroundColor: Colors.card, borderWidth: 1, borderColor: Colors.border,
    borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10,
    color: Colors.textPrimary, fontFamily: Fonts.metric, fontSize: 15, textAlign: 'center',
  },
  ttManualBtn: {
    backgroundColor: Colors.accent, borderRadius: 8, paddingVertical: 11, alignItems: 'center',
  },

  // Multi-workout selection modal
  ttModalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'center', alignItems: 'center', padding: 24,
  },
  ttModalCard: {
    backgroundColor: Colors.nested, borderRadius: 16, padding: 20,
    width: '100%', gap: 14,
  },
  ttModalTitle: { color: Colors.textPrimary, fontSize: 16, fontWeight: '700', marginBottom: 4 },
  ttWorkoutOption: {
    backgroundColor: '#242424', borderRadius: 10, padding: 14,
    borderLeftWidth: 3, borderLeftColor: Colors.accent, gap: 4,
  },
  ttWorkoutTime:   { color: Colors.textPrimary, fontSize: 15, fontWeight: '700' },
  ttWorkoutDetail: { color: Colors.textSecondary, fontSize: 13 },
  ttModalSkipBtn:  { paddingVertical: 8, alignItems: 'center' },
  ttModalSkipText: { color: Colors.textSecondary, fontSize: 13, textDecorationLine: 'underline' },
});
