import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, RefreshControl,
  StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import type { Program, ProgramDay, ProgramSession, MainStackParamList, ExerciseItem } from '../_layout';
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
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function exerciseSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function isStrengthBlock(blockName: string): boolean {
  const lower = blockName.toLowerCase();
  return !lower.includes('warm') && !lower.includes('cool');
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
  | { kind: 'circuit'; members: { ex: ExerciseItem; origIdx: number }[]; rounds: number; rest: string | null };

function groupBySuperset(exercises: ExerciseItem[]): ExGroup[] {
  const groups: ExGroup[] = [];
  let i = 0;
  while (i < exercises.length) {
    const ex = exercises[i];
    if (ex.circuit_id) {
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

// ─── Circuit group component ──────────────────────────────────────────────────

function CircuitBlock({ members, rounds, rest }: {
  members: { ex: ExerciseItem; origIdx: number }[];
  rounds: number;
  rest: string | null;
}) {
  const [currentRound, setCurrentRound] = useState(1);
  return (
    <View style={styles.circuitGroup}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <Text style={styles.circuitLabel}>CIRCUIT — {rounds} ROUNDS</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <TouchableOpacity
            onPress={() => setCurrentRound(r => Math.max(1, r - 1))}
            style={[styles.circuitRoundBtn, currentRound === 1 && styles.circuitRoundBtnDone]}
          >
            <Feather name="chevron-left" color={Colors.accent} size={16} />
          </TouchableOpacity>
          <Text style={styles.circuitRoundText}>Round {currentRound} / {rounds}</Text>
          <TouchableOpacity
            onPress={() => setCurrentRound(r => Math.min(rounds, r + 1))}
            style={[styles.circuitRoundBtn, currentRound === rounds && styles.circuitRoundBtnDone]}
          >
            <Feather name="chevron-right" color={Colors.accent} size={16} />
          </TouchableOpacity>
        </View>
      </View>
      {members.map(({ ex, origIdx }, mi) => {
        const note = ex.notes || ex.note;
        const isLast = mi === members.length - 1;
        return (
          <View key={origIdx} style={[styles.circuitExRow, isLast && { marginBottom: 0 }]}>
            <Text style={styles.exName}>{ex.name}</Text>
            {!!ex.reps && <Text style={styles.exDetail}>{ex.reps}</Text>}
            {!!note    && <Text style={styles.exDetail}>{note}</Text>}
          </View>
        );
      })}
      {!!rest && (
        <Text style={[styles.exDetail, { marginTop: 8 }]}>Rest after round: {rest}</Text>
      )}
    </View>
  );
}

// ─── Exercise renderer (non-strength sessions) ───────────────────────────────

function ExerciseSection({
  session, onStart,
}: {
  session: ProgramSession;
  onStart?: () => void;
}) {
  return (
    <View style={styles.sessionBlock}>
      <View style={styles.sessionHeaderRow}>
        <Text style={styles.sessionName}>{session.name}</Text>
        <Text style={styles.sessionMeta}>{session.time} · {session.duration_minutes} min</Text>
      </View>
      {!!session.description && (
        <Text style={styles.sessionDesc}>{session.description}</Text>
      )}
      {(session.blocks ?? []).map((block, bi) => (
        <View key={bi} style={styles.section}>
          <Text style={styles.sectionLabel}>{block.block_name}</Text>
          {groupBySuperset(block.exercises ?? []).map((group, gi) => {
            if (group.kind === 'circuit') {
              return <CircuitBlock key={gi} members={group.members} rounds={group.rounds} rest={group.rest} />;
            }
            if (group.kind === 'superset') {
              return (
                <View key={gi} style={styles.supersetGroup}>
                  <Text style={styles.supersetLabel}>Superset</Text>
                  {group.members.map(({ ex, origIdx }) => {
                    let detail = '';
                    if (ex.sets && ex.reps) detail = `${ex.sets} × ${ex.reps}`;
                    else if (ex.reps) detail = ex.reps;
                    const note = ex.notes || ex.note;
                    return (
                      <View key={origIdx} style={[styles.exRow, { borderLeftWidth: 0, paddingLeft: 0, marginBottom: 6 }]}>
                        <Text style={styles.exName}>{ex.name}</Text>
                        {!!detail && <Text style={styles.exDetail}>{detail}</Text>}
                        {!!note   && <Text style={styles.exDetail}>{note}</Text>}
                      </View>
                    );
                  })}
                </View>
              );
            }
            const { ex, origIdx } = group;
            let detail = '';
            if (ex.sets && ex.reps) detail = `${ex.sets} × ${ex.reps}`;
            else if (ex.reps) detail = ex.reps;
            const note = ex.notes || ex.note;
            return (
              <View key={origIdx} style={styles.exRow}>
                <Text style={styles.exName}>{ex.name}</Text>
                {!!detail && <Text style={styles.exDetail}>{detail}</Text>}
                {!!note   && <Text style={styles.exDetail}>{note}</Text>}
              </View>
            );
          })}
        </View>
      ))}
      {onStart && (
        <TouchableOpacity style={styles.startWorkoutBtn} onPress={onStart}>
          <Text style={styles.startWorkoutText}>START WORKOUT →</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ─── Strength session with inline per-set logging ────────────────────────────

type SetInput = { weight: string; reps: string };
type StrengthInputs = Record<string, Record<number, SetInput>>;

function StrengthSessionSection({
  session, inputs, alreadySaved, saved, saving, onChange, onSave, onStart,
}: {
  session: ProgramSession;
  inputs: StrengthInputs;
  alreadySaved: boolean;
  saved: boolean;
  saving: boolean;
  onChange: (exKey: string, setIdx: number, field: 'weight' | 'reps', value: string) => void;
  onSave: () => void;
  onStart?: () => void;
}) {
  const isDone = alreadySaved || saved;
  const [focusedSetKey, setFocusedSetKey] = useState<string | null>(null);

  let allFilled = true;
  let hasStrengthExercises = false;
  (session.blocks ?? []).forEach((block, bi) => {
    if (!isStrengthBlock(block.block_name)) return;
    (block.exercises ?? []).forEach((ex, ei) => {
      hasStrengthExercises = true;
      const exKey = `${bi}_${ei}`;
      const numSets = ex.sets ?? 1;
      for (let si = 0; si < numSets; si++) {
        if (!inputs[exKey]?.[si]?.weight?.trim()) allFilled = false;
      }
    });
  });

  return (
    <View style={styles.sessionBlock}>
      <View style={styles.sessionHeaderRow}>
        <Text style={styles.sessionName}>{session.name}</Text>
        <Text style={styles.sessionMeta}>{session.time} · {session.duration_minutes} min</Text>
      </View>
      {!!session.description && (
        <Text style={styles.sessionDesc}>{session.description}</Text>
      )}

      {(session.blocks ?? []).map((block, bi) => {
        const isStrBlock = isStrengthBlock(block.block_name);
        return (
          <View key={bi} style={isStrBlock ? styles.strBlock : styles.section}>
            <Text style={isStrBlock ? styles.strBlockLabel : styles.sectionLabel}>
              {block.block_name}
            </Text>

            {isStrBlock ? (
              <View style={styles.strExList}>
                {groupBySuperset(block.exercises ?? []).map((group, gi) => {
                  const renderStrExCard = (ex: ExerciseItem, origIdx: number) => {
                    const exKey = `${bi}_${origIdx}`;
                    const numSets = ex.sets ?? 1;
                    const prescribedReps = ex.reps
                      ? String(ex.reps).match(/\d+/)?.[0] ?? ''
                      : '';
                    return (
                      <View key={origIdx} style={styles.strExCard}>
                        <Text style={styles.strExName}>{ex.name}</Text>
                        {!!(ex.sets && ex.reps) && (
                          <Text style={styles.strExPrescribed}>{ex.sets} × {ex.reps}</Text>
                        )}
                        <View style={styles.strDivider} />
                        {!isDone && (
                          <View style={styles.setColHeaders}>
                            <Text style={styles.setColSpacer} />
                            <Text style={styles.setColHeader}>REPS</Text>
                            <Text style={styles.setColHeader}>LBS</Text>
                          </View>
                        )}
                        {Array.from({ length: numSets }, (_, si) => {
                          const set = inputs[exKey]?.[si];
                          const setKey = `${exKey}_${si}`;
                          const isActive = focusedSetKey === setKey;
                          const isDim = !isActive && !set?.weight?.trim() && !isDone;
                          if (isDone) {
                            return (
                              <View key={si} style={[styles.setRowContainer, styles.setRowSaved]}>
                                <Text style={styles.setLabelText}>SET {si + 1}</Text>
                                <View style={styles.setValuesRow}>
                                  <Text style={styles.setSavedNum}>{set?.reps || '—'}</Text>
                                  <Text style={styles.setSavedUnit}> reps</Text>
                                  <Text style={[styles.setSavedNum, { marginLeft: 20 }]}>{set?.weight || '—'}</Text>
                                  <Text style={styles.setSavedUnit}> lbs</Text>
                                </View>
                                <Text style={styles.setCheck}>✓</Text>
                              </View>
                            );
                          }
                          return (
                            <View key={si} style={[styles.setRowContainer, isActive && styles.setRowActive, isDim && styles.setRowDim]}>
                              <Text style={styles.setLabelText}>SET {si + 1}</Text>
                              <TextInput
                                style={[styles.setRepsInput, isActive && styles.setInputFocused]}
                                placeholder="0"
                                placeholderTextColor="#3a3a3a"
                                value={set?.reps ?? prescribedReps}
                                onChangeText={v => onChange(exKey, si, 'reps', v)}
                                onFocus={() => setFocusedSetKey(setKey)}
                                onBlur={() => setFocusedSetKey(null)}
                                keyboardType="numeric"
                                selectionColor={Colors.accent}
                              />
                              <View style={styles.setWeightRow}>
                                <TextInput
                                  style={[styles.setWeightInput, isActive && styles.setInputFocused]}
                                  placeholder=""
                                  placeholderTextColor="#3a3a3a"
                                  value={set?.weight ?? ''}
                                  onChangeText={v => onChange(exKey, si, 'weight', v)}
                                  onFocus={() => setFocusedSetKey(setKey)}
                                  onBlur={() => setFocusedSetKey(null)}
                                  keyboardType="numeric"
                                  selectionColor={Colors.accent}
                                />
                                <Text style={styles.setWeightSuffix}>lbs</Text>
                              </View>
                            </View>
                          );
                        })}
                      </View>
                    );
                  };

                  if (group.kind === 'circuit') {
                    return (
                      <View key={gi} style={styles.circuitGroup}>
                        <Text style={styles.circuitLabel}>CIRCUIT — {group.rounds} ROUNDS</Text>
                        {group.members.map(({ ex, origIdx }) => renderStrExCard(ex, origIdx))}
                        {!!group.rest && (
                          <Text style={[styles.exDetail, { marginTop: 4 }]}>Rest after round: {group.rest}</Text>
                        )}
                      </View>
                    );
                  }
                  if (group.kind === 'superset') {
                    return (
                      <View key={gi} style={styles.supersetGroup}>
                        <Text style={styles.supersetLabel}>Superset</Text>
                        {group.members.map(({ ex, origIdx }) => renderStrExCard(ex, origIdx))}
                      </View>
                    );
                  }
                  return renderStrExCard(group.ex, group.origIdx);
                })}
              </View>
            ) : (
              groupBySuperset(block.exercises ?? []).map((group, gi) => {
                if (group.kind === 'circuit') {
                  return <CircuitBlock key={gi} members={group.members} rounds={group.rounds} rest={group.rest} />;
                }
                if (group.kind === 'superset') {
                  return (
                    <View key={gi} style={styles.supersetGroup}>
                      <Text style={styles.supersetLabel}>Superset</Text>
                      {group.members.map(({ ex, origIdx }) => {
                        let detail = '';
                        if (ex.sets && ex.reps) detail = `${ex.sets} × ${ex.reps}`;
                        else if (ex.reps) detail = ex.reps;
                        const note = ex.notes || ex.note;
                        return (
                          <View key={origIdx} style={[styles.exRow, { borderLeftWidth: 0, paddingLeft: 0, marginBottom: 6 }]}>
                            <Text style={styles.exName}>{ex.name}</Text>
                            {!!detail && <Text style={styles.exDetail}>{detail}</Text>}
                            {!!note   && <Text style={styles.exDetail}>{note}</Text>}
                          </View>
                        );
                      })}
                    </View>
                  );
                }
                const { ex, origIdx } = group;
                let detail = '';
                if (ex.sets && ex.reps) detail = `${ex.sets} × ${ex.reps}`;
                else if (ex.reps) detail = ex.reps;
                const note = ex.notes || ex.note;
                return (
                  <View key={origIdx} style={styles.exRow}>
                    <Text style={styles.exName}>{ex.name}</Text>
                    {!!detail && <Text style={styles.exDetail}>{detail}</Text>}
                    {!!note   && <Text style={styles.exDetail}>{note}</Text>}
                  </View>
                );
              })
            )}
          </View>
        );
      })}

      {hasStrengthExercises && (
        isDone ? (
          <View style={styles.logAllBtnDone}>
            <Text style={styles.logAllBtnDoneText}>LIFTS LOGGED ✓</Text>
          </View>
        ) : (
          <TouchableOpacity
            style={[styles.logAllBtn, (!allFilled || saving) && styles.logAllBtnDisabled]}
            onPress={onSave}
            disabled={!allFilled || saving}
          >
            <Text style={styles.logAllBtnText}>
              {saving ? 'SAVING...' : 'LOG ALL LIFTS'}
            </Text>
          </TouchableOpacity>
        )
      )}
      {onStart && (
        <TouchableOpacity style={styles.startWorkoutBtn} onPress={onStart}>
          <Text style={styles.startWorkoutText}>START WORKOUT →</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

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
            <Text style={styles.trialBtnText}>{saving ? 'SAVING...' : 'LOG RESULT'}</Text>
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
        <Text style={styles.completeConfirmText}>Session complete. Good work.</Text>
      </View>
    );
  }
  return (
    <TouchableOpacity
      style={[styles.trialBtn, saving && styles.trialBtnDisabled]}
      onPress={onSave}
      disabled={saving}
    >
      <Text style={styles.trialBtnText}>{saving ? 'SAVING...' : 'MARK COMPLETE'}</Text>
    </TouchableOpacity>
  );
}

// ─── Day card ─────────────────────────────────────────────────────────────────

function DayCard({
  day, isToday, isComplete,
  userId, programId, weekNumber, savedTrials,
  expandAll, collapseToken, profile,
}: {
  day: ProgramDay;
  isToday: boolean;
  isComplete: boolean;
  userId: string | null;
  programId: string;
  weekNumber: number;
  savedTrials: Set<string>;
  expandAll: boolean;
  collapseToken: number;
  profile: TimeTrialProfile | null;
}) {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();

  function startLiveWorkout(session: ProgramSession) {
    navigation.navigate('LiveWorkout', {
      sessionJson: JSON.stringify(session),
      programId,
      weekNumber,
      dayName: day.day,
    });
  }
  const [expanded, setExpanded] = useState(isToday);

  // Expand all days when VIEW FULL WEEK is pressed
  useEffect(() => { setExpanded(expandAll); }, [expandAll]);
  // Reset to default (today expanded, others collapsed) when COLLAPSE is pressed
  useEffect(() => { if (collapseToken > 0) setExpanded(isToday); }, [collapseToken]); // eslint-disable-line react-hooks/exhaustive-deps
  const isRest = day.type === 'rest' || !day.sessions?.length;

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

  // ── Strength state (inline per-set) ─────────────────────────────────────────
  const strengthAlreadySaved = (() => {
    for (const session of day.sessions ?? []) {
      if (!isStrengthSession(session)) continue;
      for (const block of session.blocks ?? []) {
        if (!isStrengthBlock(block.block_name)) continue;
        for (const ex of block.exercises ?? []) {
          if (savedTrials.has(`${day.day}:${exerciseSlug(ex.name)}`)) return true;
        }
      }
    }
    return false;
  })();
  const [strengthInputs, setStrengthInputs] = useState<StrengthInputs>({});
  const [strengthSaved, setStrengthSaved]   = useState(false);
  const [strengthSaving, setStrengthSaving] = useState(false);

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
    setCompleteSaved(prev => ({ ...prev, [si]: true }));
    setCompleteSaving(false);
  }

  async function saveStrengthResults(session: ProgramSession) {
    if (!userId) return;
    setStrengthSaving(true);
    const rows: object[] = [];
    (session.blocks ?? []).forEach((block, bi) => {
      if (!isStrengthBlock(block.block_name)) return;
      (block.exercises ?? []).forEach((ex, ei) => {
        const exKey = `${bi}_${ei}`;
        const numSets = ex.sets ?? 1;
        const prescribedReps = ex.reps
          ? String(ex.reps).match(/\d+/)?.[0] ?? ''
          : '';
        const setsData = Array.from({ length: numSets }, (_, si) => ({
          weight: strengthInputs[exKey]?.[si]?.weight?.trim() ?? '',
          reps:   strengthInputs[exKey]?.[si]?.reps?.trim() || prescribedReps,
        }));
        rows.push({
          user_id:      userId!,
          program_id:   programId,
          day_name:     day.day,
          week_number:  weekNumber,
          session_name: session.name,
          log_field:    exerciseSlug(ex.name),
          log_value:    JSON.stringify(setsData),
          completed:    true,
          completed_at: new Date().toISOString(),
        });
      });
    });
    if (rows.length > 0) {
      const { error } = await supabase.from('session_logs').insert(rows);
      if (error) console.log('[program] saveStrengthResults error:', error.message);
    }
    setStrengthSaved(true);
    setStrengthSaving(false);
  }

  function handleStrengthChange(
    exKey: string, setIdx: number, field: 'weight' | 'reps', value: string,
  ) {
    setStrengthInputs(prev => ({
      ...prev,
      [exKey]: {
        ...(prev[exKey] ?? {}),
        [setIdx]: {
          ...(prev[exKey]?.[setIdx] ?? { weight: '', reps: '' }),
          [field]: value,
        },
      },
    }));
  }

  return (
    <>
    <View style={[styles.dayCard, isToday && styles.dayCardToday]}>
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => setExpanded(e => !e)}
        style={styles.dayCardHeader}
      >
        <View style={styles.dayCardLeft}>
          <Text style={[styles.dayName, isToday && { color: Colors.accent }]}>{day.day}</Text>
          {isComplete && <Feather name="check" color={Colors.green} size={14} style={{ marginLeft: 6 }} />}
        </View>
        <View style={styles.dayCardRight}>
          <Text style={styles.sessionType}>{day.type}</Text>
          {expanded
            ? <Feather name="chevron-up" color={Colors.textSecondary} size={16} />
            : <Feather name="chevron-down" color={Colors.textSecondary} size={16} />}
        </View>
      </TouchableOpacity>

      {expanded && (
        <View style={styles.expandedContent}>
          {isRest ? (
            <Text style={styles.restNote}>Rest — recover well.</Text>
          ) : (
            (day.sessions ?? []).map((session, si) =>
              isStrengthSession(session) ? (
                <StrengthSessionSection
                  key={si}
                  session={session}
                  inputs={strengthInputs}
                  alreadySaved={strengthAlreadySaved}
                  saved={strengthSaved}
                  saving={strengthSaving}
                  onChange={handleStrengthChange}
                  onSave={() => saveStrengthResults(session)}
                  onStart={() => startLiveWorkout(session)}
                />
              ) : (
                <View key={si} style={styles.sessionWrapper}>
                  <ExerciseSection session={session} onStart={() => startLiveWorkout(session)} />
                  {session.log_result ? (
                    <>
                      <TrialLogCard
                        label={session.log_label}
                        value={trialValues[si] ?? ''}
                        saved={trialSaved[si] ?? false}
                        saving={trialSaving}
                        onChange={v => setTrialValues(prev => ({ ...prev, [si]: v }))}
                        onSave={() => saveTrialResult(si, session)}
                      />
                      {weekNumber === 1 && !isStrengthSession(session) && trialSaved[si] && ttStatus !== 'idle' && (
                        <View style={styles.ttStatusCard}>
                          {(ttStatus === 'matching' || ttStatus === 'matched') && (
                            <View style={styles.ttRow}>
                              <ActivityIndicator color={Colors.accent} size="small" />
                              <Text style={styles.ttStatusText}>
                                {ttStatus === 'matching' ? 'Searching Apple Health...' : 'Matched · Deriving zones...'}
                              </Text>
                            </View>
                          )}
                          {ttStatus === 'zonesSet' && (
                            <Text style={styles.ttSuccessText}>Training zones set</Text>
                          )}
                          {ttStatus === 'multiple' && (
                            <TouchableOpacity style={styles.ttRow} onPress={() => setTtModalVisible(true)}>
                              <Text style={styles.ttStatusText}>{ttWorkouts.length} runs found — tap to choose ›</Text>
                            </TouchableOpacity>
                          )}
                          {ttStatus === 'notFound' && (
                            <View style={styles.ttManualEntry}>
                              <Text style={styles.ttStatusText}>No matching run in Health. Enter manually:</Text>
                              <View style={styles.ttManualRow}>
                                <TextInput
                                  style={styles.ttManualInput}
                                  placeholder={profile?.preferred_units === 'imperial' ? 'mi' : 'km'}
                                  placeholderTextColor={Colors.textSecondary}
                                  value={ttManualDist}
                                  onChangeText={setTtManualDist}
                                  keyboardType="decimal-pad"
                                  selectionColor={Colors.accent}
                                />
                                <TextInput
                                  style={styles.ttManualInput}
                                  placeholder="mm:ss"
                                  placeholderTextColor={Colors.textSecondary}
                                  value={ttManualDuration}
                                  onChangeText={setTtManualDuration}
                                  keyboardType="numbers-and-punctuation"
                                  selectionColor={Colors.accent}
                                />
                              </View>
                              <TouchableOpacity
                                style={[styles.ttManualBtn, (!ttManualDist || !ttManualDuration || ttDeriving) && styles.trialBtnDisabled]}
                                onPress={() => ttTrialType && saveManualZones(ttTrialType)}
                                disabled={!ttManualDist || !ttManualDuration || ttDeriving}
                              >
                                <Text style={styles.trialBtnText}>{ttDeriving ? 'SETTING ZONES...' : 'SET ZONES'}</Text>
                              </TouchableOpacity>
                            </View>
                          )}
                        </View>
                      )}
                    </>
                  ) : (
                    <MarkCompleteCard
                      saved={completeSaved[si] ?? false}
                      saving={completeSaving}
                      onSave={() => markSessionComplete(si, session.name)}
                    />
                  )}
                </View>
              )
            )
          )}
        </View>
      )}
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
  const [expandAll, setExpandAll]         = useState(false);
  const [collapseToken, setCollapseToken] = useState(0);
  const [ttProfile, setTtProfile]         = useState<TimeTrialProfile | null>(null);
  const scrollViewRef = useRef<ScrollView>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [activeProgram, setActiveProgram]       = useState<Program | null>(null);
  const [generatingNextWeek, setGeneratingNextWeek] = useState(false);
  const [nextWeekReady, setNextWeekReady]       = useState(false);
  const nextWeekTriggeredRef = useRef(false);

  async function checkAndGenerateNextWeek(uid: string, prog: Program, completedDayCount: number) {
    if (nextWeekTriggeredRef.current) return;
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    const days  = prog.program_data?.days ?? [];
    const trainingDays = days.filter(d => d.type !== 'rest' && (d.sessions ?? []).length > 0);
    const isLastDay    = trainingDays.length > 0 && trainingDays[trainingDays.length - 1].day === today;

    if (completedDayCount < 5 && !isLastDay) return;

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
    setLoading(true);
    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) { setLoading(false); return; }
    setUserId(authData.user.id);

    const [progsRes, logsRes, profileRes] = await Promise.all([
      supabase
        .from('programs')
        .select('*')
        .eq('user_id', authData.user.id)
        .order('week_number', { ascending: true }),
      supabase
        .from('session_logs')
        .select('week_number, day_name, log_field')
        .eq('user_id', authData.user.id)
        .not('day_name', 'is', null),
      supabase
        .from('profiles')
        .select('goal, age, preferred_units')
        .eq('id', authData.user.id)
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
        goal:            (profileRes.data as any).goal ?? null,
        age:             (profileRes.data as any).age ?? null,
        preferred_units: (profileRes.data as any).preferred_units ?? null,
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
      checkAndGenerateNextWeek(authData.user.id, active, activeCompletedCount);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Scroll to today's card after loading completes
  useEffect(() => {
    if (loading || !isViewingCurrentWeek) return;
    const todayIdx = days.findIndex(d => d.day === todayName);
    if (todayIdx <= 0) return;
    // Approximate offset: heading ~56px + weekRow ~65px + button ~52px + (collapsed cards above × ~70px)
    const offset = Math.max(0, 173 + todayIdx * 70 - 60);
    setTimeout(() => scrollViewRef.current?.scrollTo({ y: offset, animated: true }), 300);
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
          {nextWeekReady && !generatingNextWeek && activeProgram && allPrograms.some(p => p.week_number === activeProgram.week_number + 1) && (
            <View style={[styles.nextWeekBanner, styles.nextWeekBannerReady]}>
              <Feather name="calendar" color={Colors.green} size={22} style={{ marginRight: 12 }} />
              <View>
                <Text style={[styles.nextWeekTitle, { color: Colors.green }]}>
                  Week {activeProgram.week_number + 1} is ready.
                </Text>
                <Text style={styles.nextWeekSub}>Tap the arrows above to view it.</Text>
              </View>
            </View>
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

          {/* VIEW FULL WEEK / COLLAPSE toggle */}
          {days.length > 0 && (
            <TouchableOpacity
              style={styles.expandAllBtn}
              onPress={() => {
                if (!expandAll) {
                  setExpandAll(true);
                } else {
                  setExpandAll(false);
                  setCollapseToken(t => t + 1);
                }
              }}
            >
              <Text style={styles.expandAllText}>
                {expandAll ? 'COLLAPSE' : 'VIEW FULL WEEK'}
              </Text>
            </TouchableOpacity>
          )}

          {allPrograms.length === 0 ? (
            <Text style={styles.emptyText}>No program found.</Text>
          ) : days.length === 0 ? (
            <Text style={styles.emptyText}>No days in this week.</Text>
          ) : (
            <View style={styles.dayList}>
              {days.map(day => (
                <DayCard
                  key={day.day}
                  day={day}
                  isToday={isViewingCurrentWeek && day.day === todayName}
                  isComplete={completedDays.has(day.day)}
                  userId={userId}
                  programId={currentProgram?.id ?? ''}
                  weekNumber={displayWeekNum}
                  savedTrials={savedTrials}
                  expandAll={expandAll}
                  collapseToken={collapseToken}
                  profile={ttProfile}
                />
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

  expandAllBtn: {
    marginHorizontal: 16, marginBottom: 12, paddingVertical: 11,
    borderRadius: 10, borderWidth: 1, borderColor: Colors.accent,
    alignItems: 'center',
  },
  expandAllText: { color: Colors.accent, fontSize: 12, fontWeight: '700', letterSpacing: 1.2 },

  dayList:      { paddingHorizontal: 16, gap: 10 },
  dayCard:      { backgroundColor: Colors.card, borderRadius: 14, overflow: 'hidden' },
  dayCardToday: { borderLeftWidth: 3, borderLeftColor: Colors.accent },

  dayCardHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: 16,
  },
  dayCardLeft:  { flexDirection: 'row', alignItems: 'center' },
  dayCardRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dayName:      { color: Colors.textPrimary, fontSize: 15, fontWeight: '700' },
  sessionType:  { color: Colors.textSecondary, fontSize: 13 },

  expandedContent: { paddingHorizontal: 16, paddingBottom: 16, gap: 16 },
  sessionWrapper:  { gap: 12 },

  sessionBlock:     { gap: 10 },
  sessionHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  sessionName:      { color: Colors.textPrimary, fontSize: 14, fontWeight: '700', flex: 1 },
  sessionMeta:      { color: Colors.textSecondary, fontSize: 12 },
  sessionDesc:      { color: Colors.textSecondary, fontSize: 13, lineHeight: 18 },

  section:      { gap: 8 },
  sectionLabel: {
    color: Colors.textSecondary, fontSize: 11, fontWeight: '700',
    letterSpacing: 1.2, textTransform: 'uppercase',
  },

  // Non-strength exercise rows
  exRow:    { borderLeftWidth: 3, borderLeftColor: Colors.accent, paddingLeft: 10, gap: 2 },
  exName:   { color: Colors.textPrimary, fontSize: 14, fontWeight: '600' },
  exDetail: { color: Colors.textSecondary, fontSize: 13 },

  // Superset grouping — 3px accent at 50% opacity
  supersetGroup: {
    borderLeftWidth: 3,
    borderLeftColor: 'rgba(232,255,71,0.5)',
    paddingLeft: 10,
    gap: 6,
    marginBottom: 4,
  },
  supersetLabel: {
    color: 'rgba(232,255,71,0.7)',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 2,
  },

  // Circuit grouping — 3px accent
  circuitGroup: {
    borderLeftWidth: 3,
    borderLeftColor: Colors.accent,
    paddingLeft: 10,
    gap: 6,
    marginBottom: 4,
  },
  circuitLabel: {
    color: Colors.accent,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  circuitRoundTracker: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  circuitRoundText: {
    color: Colors.textPrimary,
    fontFamily: Fonts.metric,
    fontSize: 13,
  },
  circuitRoundBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.nested,
    alignItems: 'center',
    justifyContent: 'center',
  },
  circuitRoundBtnDone: {
    opacity: 0.3,
  },
  circuitExRow: {
    gap: 2,
    marginBottom: 8,
  },

  // Start Workout button
  startWorkoutBtn: {
    marginTop: 14, paddingVertical: 12, borderRadius: 10,
    backgroundColor: Colors.accent, alignItems: 'center',
  },
  startWorkoutText: { color: Colors.background, fontSize: 12, fontWeight: '800', letterSpacing: 1.5 },

  // Strength block section header
  strBlock:      { gap: 0 },
  strBlockLabel: {
    color: Colors.textSecondary, fontSize: 11, fontWeight: '700',
    letterSpacing: 2, textTransform: 'uppercase', marginBottom: 16,
  },

  // Exercise card list spacing
  strExList: { gap: 20 },

  // Individual exercise card
  strExCard: {
    backgroundColor: Colors.card,
    borderRadius: 16,
    padding: 20,
    borderLeftWidth: 3,
    borderLeftColor: Colors.accent,
  },
  strExName:       { color: Colors.textPrimary, fontSize: 17, fontWeight: '700', marginBottom: 4 },
  strExPrescribed: { color: Colors.textSecondary, fontSize: 13, marginBottom: 16 },
  strDivider:      { height: 1, backgroundColor: Colors.nested, marginBottom: 12 },

  // Set row containers
  setRowContainer: {
    backgroundColor: Colors.nested,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  setRowActive: {
    backgroundColor: '#222222',
    borderLeftWidth: 3,
    borderLeftColor: Colors.accent,
    paddingLeft: 13,
  },
  setRowSaved: { backgroundColor: '#1a2a00' },
  setRowDim:   { opacity: 0.55 },

  setColHeaders: {
    flexDirection: 'row', alignItems: 'center',
    gap: 12, marginBottom: 4,
  },
  setColSpacer: { width: 44 },
  setColHeader: {
    flex: 1, color: Colors.textSecondary, fontSize: 10, fontWeight: '600',
    letterSpacing: 1.5, textTransform: 'uppercase', textAlign: 'center',
  },

  setLabelText: {
    color: '#b0ada6', fontSize: 11, fontWeight: '700',
    letterSpacing: 1, textTransform: 'uppercase', width: 44,
  },
  setValuesRow: { flex: 1, flexDirection: 'row', alignItems: 'baseline' },
  setSavedNum:  { color: Colors.accent, fontFamily: Fonts.metric, fontSize: 22 },
  setSavedUnit: { color: Colors.textSecondary, fontSize: 12 },
  setCheck:     { color: Colors.green, fontSize: 14, fontWeight: '700', marginLeft: 8 },

  setRepsInput: {
    width: 70,
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: 'transparent',
    borderRadius: 8,
    paddingVertical: 6,
    color: Colors.textPrimary,
    fontFamily: Fonts.metric,
    fontSize: 22,
    textAlign: 'center',
  },
  setWeightRow: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end',
  },
  setWeightInput: {
    flex: 1,
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: 'transparent',
    borderRadius: 8,
    paddingVertical: 6,
    color: Colors.textPrimary,
    fontFamily: Fonts.metric,
    fontSize: 22,
    textAlign: 'center',
  },
  setWeightSuffix: { color: '#b0ada6', fontSize: 12, marginLeft: 4, width: 24 },
  setInputFocused: { borderColor: Colors.accent },

  // LOG ALL LIFTS button
  logAllBtn: {
    backgroundColor: Colors.accent,
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
    marginTop: 8,
  },
  logAllBtnDisabled: { opacity: 0.35 },
  logAllBtnText: {
    color: Colors.background, fontSize: 15, fontWeight: '800', letterSpacing: 1.5,
  },
  logAllBtnDone: {
    backgroundColor: '#1a2a00',
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
    marginTop: 8,
  },
  logAllBtnDoneText: {
    color: Colors.accent, fontSize: 15, fontWeight: '800', letterSpacing: 1.5,
  },

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
