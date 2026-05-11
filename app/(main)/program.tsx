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
  current_training_days: string | null;
  rest_days: number | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function exerciseSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function isSwappableRun(name: string): boolean {
  if (!/run/i.test(name)) return false;
  const lower = name.toLowerCase();
  return !['sled', 'farmers carry', 'sandbag', 'wall ball', 'burpee broad jump'].some(h => lower.includes(h));
}

function applySwapName(name: string, swap: 'ski' | 'row'): string {
  const to = swap === 'ski' ? 'Ski Erg' : 'Row Erg';
  return name.replace(/\brunning\b/gi, to).replace(/\brun\b/gi, to);
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

// ─── Circuit group component ──────────────────────────────────────────────────

function CircuitBlock({ members, rounds, rest }: {
  members: { ex: ExerciseItem; origIdx: number }[];
  rounds: number;
  rest: string | null;
}) {
  return (
    <View style={styles.circuitGroup}>
      <Text style={styles.circuitLabel}>CIRCUIT · {rounds} ROUNDS</Text>
      <View style={styles.circuitBody}>
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
          <Text style={styles.circuitRestText}>Rest {rest} between rounds</Text>
        )}
      </View>
    </View>
  );
}

// ─── Block group component ────────────────────────────────────────────────────

function BlockGroupSection({ blockName, members }: {
  blockName: string;
  members: { ex: ExerciseItem; origIdx: number }[];
}) {
  return (
    <View style={styles.blockGroup}>
      <Text style={styles.blockGroupName}>{blockName}</Text>
      {members.map(({ ex, origIdx }, mi) => {
        let detail = '';
        if (ex.sets && ex.reps) detail = `${ex.sets} × ${ex.reps}`;
        else if (ex.reps) detail = ex.reps;
        const note = ex.notes || ex.note;
        const isLast = mi === members.length - 1;
        return (
          <View key={origIdx}>
            <View style={styles.blockExRow}>
              <Text style={styles.exName}>{ex.name}</Text>
              {!!detail && <Text style={styles.exDetail}>{detail}</Text>}
              {!!note   && <Text style={styles.exDetail}>{note}</Text>}
            </View>
            {!isLast && <View style={styles.blockDivider} />}
          </View>
        );
      })}
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
  const [swapOverrides,   setSwapOverrides]   = useState<Record<string, 'ski' | 'row'>>({});
  const [swapSheetVisible, setSwapSheetVisible] = useState(false);
  const [swapTarget, setSwapTarget] = useState<{ key: string; ex: ExerciseItem } | null>(null);
  const [preferredSwap, setPreferredSwap] = useState<'ski' | 'row' | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    AsyncStorage.getItem('preferred_run_swap').then(val => {
      if (val === 'ski' || val === 'row') setPreferredSwap(val as 'ski' | 'row');
    });
    supabase.auth.getSession().then(({ data: { session: s } }) => setUserId(s?.user?.id ?? null));
  }, []);

  async function applySwap(choice: 'run' | 'ski' | 'row') {
    if (!swapTarget) return;
    setSwapSheetVisible(false);
    if (choice === 'run') {
      setSwapOverrides(prev => { const n = { ...prev }; delete n[swapTarget.key]; return n; });
      return;
    }
    setPreferredSwap(choice);
    AsyncStorage.setItem('preferred_run_swap', choice).catch(() => {});
    setSwapOverrides(prev => ({ ...prev, [swapTarget!.key]: choice }));
    if (userId) {
      fetch('https://peak65.vercel.app/api/recalculate-run-swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          originalExercise: { name: swapTarget.ex.name, reps: swapTarget.ex.reps, sets: swapTarget.ex.sets, coaching_cue: swapTarget.ex.notes || (swapTarget.ex as any).note },
          swapTo: choice,
        }),
      }).catch(() => {});
    }
  }

  const currentSwapChoice = swapTarget ? (swapOverrides[swapTarget.key] ?? 'run') : 'run';

  return (
    <>
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
            if (group.kind === 'block') {
              return <BlockGroupSection key={gi} blockName={group.blockName} members={group.members} />;
            }
            if (group.kind === 'part-circuit') {
              return (
                <View key={gi} style={styles.partWrapper}>
                  <View style={styles.partDivider} />
                  <Text style={styles.partName}>{group.blockName}</Text>
                  <CircuitBlock members={group.members} rounds={group.rounds} rest={group.rest} />
                </View>
              );
            }
            if (group.kind === 'part-superset') {
              return (
                <View key={gi} style={styles.partWrapper}>
                  <View style={styles.partDivider} />
                  <Text style={styles.partName}>{group.blockName}</Text>
                  <View style={styles.supersetGroup}>
                    <Text style={styles.supersetLabel}>Superset</Text>
                    {group.members.map(({ ex, origIdx }) => {
                      let detail = '';
                      if (ex.sets && ex.reps) detail = `${ex.sets} × ${ex.reps}`;
                      else if (ex.reps) detail = ex.reps;
                      const note = ex.notes || ex.note;
                      return (
                        <View key={origIdx} style={[styles.exRow, { borderWidth: 0, padding: 0, marginBottom: 6 }]}>
                          <Text style={styles.exName}>{ex.name}</Text>
                          {!!detail && <Text style={styles.exDetail}>{detail}</Text>}
                          {!!note   && <Text style={styles.exDetail}>{note}</Text>}
                        </View>
                      );
                    })}
                  </View>
                </View>
              );
            }
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
                      <View key={origIdx} style={[styles.exRow, { borderWidth: 0, padding: 0, marginBottom: 6 }]}>
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
            const exKey = `${bi}-${gi}`;
            const swapOverride = swapOverrides[exKey];
            const displayName = swapOverride ? applySwapName(ex.name, swapOverride) : ex.name;
            let detail = '';
            if (ex.sets && ex.reps) detail = `${ex.sets} × ${ex.reps}`;
            else if (ex.reps) detail = ex.reps;
            const note = ex.notes || ex.note;
            const canSwap = isSwappableRun(ex.name);
            return (
              <View key={origIdx} style={styles.exRow}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={styles.exName}>{displayName}</Text>
                  {canSwap && (
                    <TouchableOpacity
                      style={styles.swapBtn}
                      onPress={() => { setSwapTarget({ key: exKey, ex }); setSwapSheetVisible(true); }}
                    >
                      <Text style={styles.swapBtnTxt}>Swap</Text>
                    </TouchableOpacity>
                  )}
                </View>
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

    <Modal
      visible={swapSheetVisible}
      transparent
      animationType="slide"
      onRequestClose={() => setSwapSheetVisible(false)}
    >
      <TouchableOpacity
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }}
        activeOpacity={1}
        onPress={() => setSwapSheetVisible(false)}
      />
      <View style={styles.swapSheet}>
        <Text style={styles.swapSheetTitle}>SWAP EXERCISE</Text>
        {(['run', 'ski', 'row'] as const).map(option => {
          const label = option === 'run' ? 'Run' : option === 'ski' ? 'Ski Erg' : 'Row Erg';
          const isSelected = option === currentSwapChoice;
          const isPref = option !== 'run' && option === preferredSwap && !swapTarget?.key;
          return (
            <TouchableOpacity
              key={option}
              style={[styles.swapOption, isSelected && styles.swapOptionSelected]}
              onPress={() => applySwap(option)}
            >
              <Text style={[styles.swapOptionText, isSelected && styles.swapOptionTextSelected]}>
                {label}{isPref ? '  ·  preferred' : ''}
              </Text>
            </TouchableOpacity>
          );
        })}
        <TouchableOpacity style={styles.swapCancelBtn} onPress={() => setSwapSheetVisible(false)}>
          <Text style={styles.swapCancelText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </Modal>
    </>
  );
}

function StrengthSessionSection({
  session, onStart,
}: {
  session: ProgramSession;
  onStart?: () => void;
}) {
  const renderStrExCard = (ex: ExerciseItem, origIdx: number) => {
    const note = ex.notes || ex.note;
    return (
      <View key={origIdx} style={styles.strExCard}>
        <Text style={styles.strExName}>{ex.name}</Text>
        {!!(ex.sets && ex.reps) && (
          <Text style={styles.strExPrescribed}>{ex.sets} × {ex.reps}</Text>
        )}
        {!!note && <Text style={styles.strExNote}>{note}</Text>}
      </View>
    );
  };

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
                  if (group.kind === 'block') {
                    return <BlockGroupSection key={gi} blockName={group.blockName} members={group.members} />;
                  }
                  if (group.kind === 'part-circuit') {
                    return (
                      <View key={gi} style={styles.partWrapper}>
                        <View style={styles.partDivider} />
                        <Text style={styles.partName}>{group.blockName}</Text>
                        <View style={styles.circuitGroup}>
                          <Text style={styles.circuitLabel}>CIRCUIT · {group.rounds} ROUNDS</Text>
                          <View style={styles.circuitBody}>
                            {group.members.map(({ ex, origIdx }) => renderStrExCard(ex, origIdx))}
                            {!!group.rest && <Text style={styles.circuitRestText}>Rest {group.rest} between rounds</Text>}
                          </View>
                        </View>
                      </View>
                    );
                  }
                  if (group.kind === 'part-superset') {
                    return (
                      <View key={gi} style={styles.partWrapper}>
                        <View style={styles.partDivider} />
                        <Text style={styles.partName}>{group.blockName}</Text>
                        <View style={styles.supersetGroup}>
                          <Text style={styles.supersetLabel}>Superset</Text>
                          {group.members.map(({ ex, origIdx }) => renderStrExCard(ex, origIdx))}
                        </View>
                      </View>
                    );
                  }
                  if (group.kind === 'circuit') {
                    return (
                      <View key={gi} style={styles.circuitGroup}>
                        <Text style={styles.circuitLabel}>CIRCUIT · {group.rounds} ROUNDS</Text>
                        <View style={styles.circuitBody}>
                          {group.members.map(({ ex, origIdx }) => renderStrExCard(ex, origIdx))}
                          {!!group.rest && (
                            <Text style={styles.circuitRestText}>Rest {group.rest} between rounds</Text>
                          )}
                        </View>
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
                if (group.kind === 'block') {
                  return <BlockGroupSection key={gi} blockName={group.blockName} members={group.members} />;
                }
                if (group.kind === 'part-circuit') {
                  return (
                    <View key={gi} style={styles.partWrapper}>
                      <View style={styles.partDivider} />
                      <Text style={styles.partName}>{group.blockName}</Text>
                      <CircuitBlock members={group.members} rounds={group.rounds} rest={group.rest} />
                    </View>
                  );
                }
                if (group.kind === 'part-superset') {
                  return (
                    <View key={gi} style={styles.partWrapper}>
                      <View style={styles.partDivider} />
                      <Text style={styles.partName}>{group.blockName}</Text>
                      <View style={styles.supersetGroup}>
                        <Text style={styles.supersetLabel}>Superset</Text>
                        {group.members.map(({ ex, origIdx }) => {
                          let detail = '';
                          if (ex.sets && ex.reps) detail = `${ex.sets} × ${ex.reps}`;
                          else if (ex.reps) detail = ex.reps;
                          const note = ex.notes || ex.note;
                          return (
                            <View key={origIdx} style={[styles.exRow, { borderWidth: 0, padding: 0, marginBottom: 6 }]}>
                              <Text style={styles.exName}>{ex.name}</Text>
                              {!!detail && <Text style={styles.exDetail}>{detail}</Text>}
                              {!!note   && <Text style={styles.exDetail}>{note}</Text>}
                            </View>
                          );
                        })}
                      </View>
                    </View>
                  );
                }
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
                          <View key={origIdx} style={[styles.exRow, { borderWidth: 0, padding: 0, marginBottom: 6 }]}>
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
    navigation.getParent()?.navigate('LiveWorkout', {
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
          {nextWeekReady && !generatingNextWeek && !nextWeekBannerDismissed && activeProgram && allPrograms.some(p => p.week_number === activeProgram.week_number + 1) && (
            <TouchableOpacity
              style={[styles.nextWeekBanner, styles.nextWeekBannerReady]}
              onPress={() => {
                AsyncStorage.setItem('dismissed_next_week_banner', 'true');
                setNextWeekBannerDismissed(true);
              }}
              activeOpacity={0.8}
            >
              <Feather name="calendar" color={Colors.green} size={22} style={{ marginRight: 12 }} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.nextWeekTitle, { color: Colors.green }]}>
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

  sessionBlock:     { gap: 12 },
  sessionHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  sessionName:      { color: Colors.textPrimary, fontSize: 14, fontWeight: '700', flex: 1 },
  sessionMeta:      { color: Colors.textSecondary, fontSize: 12 },
  sessionDesc:      { color: Colors.textSecondary, fontSize: 13, lineHeight: 18 },

  section:      { gap: 12 },
  sectionLabel: {
    color: Colors.textSecondary, fontSize: 10, fontWeight: '700',
    letterSpacing: 3, textTransform: 'uppercase',
  },

  // Non-strength exercise rows
  exRow:    { borderWidth: 2, borderColor: 'rgba(255,255,255,0.08)', padding: 10, gap: 2 },
  exName:   { color: Colors.textPrimary, fontSize: 15, fontWeight: '600' },
  exDetail: { color: Colors.textSecondary, fontSize: 13 },

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
    marginBottom: 8,
  },
  circuitLabel: {
    color: Colors.accent,
    fontFamily: Fonts.metric,
    fontSize: 15,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  circuitBody: {
    borderLeftWidth: 3,
    borderLeftColor: Colors.accent,
    paddingLeft: 12,
    gap: 6,
  },
  circuitRestText: {
    color: Colors.textSecondary,
    fontSize: 12,
    marginTop: 4,
  },
  circuitExRow: {
    gap: 2,
    marginBottom: 4,
  },

  // Block group (named sub-group within a session block)
  blockGroup:     { gap: 0, marginBottom: 4 },
  blockGroupName: { color: Colors.textPrimary, fontSize: 16, fontFamily: Fonts.metric, marginBottom: 8 },
  blockExRow:     { paddingVertical: 6, gap: 2 },
  blockDivider:   { height: 0.5, backgroundColor: 'rgba(255,255,255,0.08)' },

  // Part wrapper (Part wrapping a Circuit or Superset)
  partWrapper:    { marginBottom: 4 },
  partDivider:    { height: 0.5, backgroundColor: 'rgba(255,255,255,0.08)', marginBottom: 8 },
  partName:       { color: Colors.textPrimary, fontSize: 16, fontFamily: Fonts.metric, marginBottom: 8 },

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
  strExPrescribed: { color: Colors.textSecondary, fontSize: 13, marginBottom: 4 },
  strExNote:       { color: Colors.textSecondary, fontSize: 13, fontStyle: 'italic' },
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
