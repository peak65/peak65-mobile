import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '../../lib/supabase';
import type { Program, ProgramDay, ProgramSession } from '../_layout';

const YELLOW    = '#e8ff47';
const BLACK     = '#080808';
const OFF_WHITE = '#f0ede8';
const GREY      = '#8a877f';
const CARD_BG   = '#111111';
const GREEN     = '#44ff88';

// ─── Strength lift definitions ────────────────────────────────────────────────

const LIFTS = [
  { name: 'Back Squat',  field: 'back_squat'  },
  { name: 'Bench Press', field: 'bench_press' },
  { name: 'Strict OHP',  field: 'strict_ohp'  },
  { name: 'Deadlift',    field: 'deadlift'    },
];

const LIFT_FIELDS = LIFTS.map(l => l.field);

function isStrengthSession(session: ProgramSession): boolean {
  if (session.log_field === 'strength_results') return true;
  const names = (session.blocks ?? [])
    .flatMap(b => b.exercises ?? [])
    .map(e => e.name.toLowerCase());
  return ['back squat', 'bench press', 'ohp', 'deadlift'].some(kw =>
    names.some(n => n.includes(kw))
  );
}

// ─── Exercise renderer (no log UI) ───────────────────────────────────────────

function ExerciseSection({ session }: { session: ProgramSession }) {
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
          {(block.exercises ?? []).map((ex, ei) => {
            let detail = '';
            if (ex.sets && ex.reps) detail = `${ex.sets} × ${ex.reps}`;
            else if (ex.reps) detail = ex.reps;
            const note = ex.notes || ex.note;
            return (
              <View key={ei} style={styles.exRow}>
                <Text style={styles.exName}>{ex.name}</Text>
                {!!detail && <Text style={styles.exDetail}>{detail}</Text>}
                {!!note   && <Text style={styles.exDetail}>{note}</Text>}
              </View>
            );
          })}
        </View>
      ))}
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
            placeholderTextColor={GREY}
            value={value}
            onChangeText={onChange}
            selectionColor={YELLOW}
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

// ─── Multi-lift strength log card ─────────────────────────────────────────────

function StrengthLogCard({
  alreadySaved, saved, saving, values,
  onChange, onSave,
}: {
  alreadySaved: boolean;
  saved: boolean;
  saving: boolean;
  values: Record<string, string>;
  onChange: (field: string, v: string) => void;
  onSave: () => void;
}) {
  const isDone = alreadySaved || saved;
  const allFilled = LIFTS.every(l => values[l.field]?.trim());

  return (
    <View style={styles.trialCard}>
      <Text style={styles.trialLabel}>Log your 3RM</Text>

      {LIFTS.map(lift => (
        <View key={lift.field} style={styles.liftRow}>
          <Text style={styles.liftName}>{lift.name}</Text>
          {isDone ? (
            <View style={styles.liftSavedCell}>
              <Text style={styles.liftSavedValue}>{values[lift.field] || '—'}</Text>
              <Text style={styles.liftSavedUnit}>lbs</Text>
              <Text style={styles.liftCheck}>✓</Text>
            </View>
          ) : (
            <TextInput
              style={styles.liftInput}
              placeholder="0"
              placeholderTextColor={GREY}
              value={values[lift.field] ?? ''}
              onChangeText={v => onChange(lift.field, v)}
              keyboardType="numeric"
              selectionColor={YELLOW}
            />
          )}
        </View>
      ))}

      {isDone ? (
        <Text style={styles.trialSavedBadge}>Lifts logged ✓</Text>
      ) : (
        <TouchableOpacity
          style={[styles.trialBtn, (!allFilled || saving) && styles.trialBtnDisabled]}
          onPress={onSave}
          disabled={!allFilled || saving}
        >
          <Text style={styles.trialBtnText}>{saving ? 'SAVING...' : 'LOG ALL LIFTS'}</Text>
        </TouchableOpacity>
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
}: {
  day: ProgramDay;
  isToday: boolean;
  isComplete: boolean;
  userId: string | null;
  programId: string;
  weekNumber: number;
  savedTrials: Set<string>; // "dayName:logField" strings already in DB
}) {
  const [expanded, setExpanded] = useState(isToday);
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

  // ── Strength state (multi-lift sessions) ────────────────────────────────────
  const strengthAlreadySaved = LIFT_FIELDS.some(f => savedTrials.has(`${day.day}:${f}`));
  const [strengthValues, setStrengthValues] = useState<Record<string, string>>({});
  const [strengthSaved, setStrengthSaved]   = useState(false);
  const [strengthSaving, setStrengthSaving] = useState(false);

  // ── Mark-complete state (cardio / Z2 / regular sessions) ────────────────────
  const completeAlreadySaved = savedTrials.has(`${day.day}:session_complete`);
  const [completeSaved, setCompleteSaved]   = useState<Record<number, boolean>>(() => {
    const init: Record<number, boolean> = {};
    (day.sessions ?? []).forEach((s, i) => {
      if (!s.log_result && !isStrengthSession(s)) init[i] = completeAlreadySaved;
    });
    return init;
  });
  const [completeSaving, setCompleteSaving] = useState(false);

  async function saveTrialResult(si: number, session: ProgramSession) {
    if (!userId || !trialValues[si]?.trim()) return;
    setTrialSaving(true);
    await supabase.from('session_logs').insert({
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
    setTrialSaved(prev => ({ ...prev, [si]: true }));
    setTrialSaving(false);
  }

  async function markSessionComplete(si: number, sessionName: string) {
    if (!userId) return;
    setCompleteSaving(true);
    await supabase.from('session_logs').insert({
      user_id:      userId,
      program_id:   programId,
      day_name:     day.day,
      week_number:  weekNumber,
      session_name: sessionName,
      log_field:    'session_complete',
      completed:    true,
      completed_at: new Date().toISOString(),
    });
    setCompleteSaved(prev => ({ ...prev, [si]: true }));
    setCompleteSaving(false);
  }

  async function saveStrengthResults(sessionName: string) {
    if (!userId) return;
    setStrengthSaving(true);
    const rows = LIFTS
      .filter(l => strengthValues[l.field]?.trim())
      .map(l => ({
        user_id:      userId!,
        program_id:   programId,
        day_name:     day.day,
        week_number:  weekNumber,
        session_name: sessionName,
        log_field:    l.field,
        log_value:    strengthValues[l.field].trim(),
        completed:    true,
        completed_at: new Date().toISOString(),
      }));
    if (rows.length > 0) await supabase.from('session_logs').insert(rows);
    setStrengthSaved(true);
    setStrengthSaving(false);
  }

  return (
    <View style={[styles.dayCard, isToday && styles.dayCardToday]}>
      {/* Header — only tap target */}
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => setExpanded(e => !e)}
        style={styles.dayCardHeader}
      >
        <View style={styles.dayCardLeft}>
          <Text style={[styles.dayName, isToday && { color: YELLOW }]}>{day.day}</Text>
          {isComplete && <Text style={styles.checkmark}> ✓</Text>}
        </View>
        <View style={styles.dayCardRight}>
          <Text style={styles.sessionType}>{day.type}</Text>
          <Text style={styles.chevron}>{expanded ? '▲' : '▼'}</Text>
        </View>
      </TouchableOpacity>

      {/* Expanded content */}
      {expanded && (
        <View style={styles.expandedContent}>
          {isRest ? (
            <Text style={styles.restNote}>Rest — recover well.</Text>
          ) : (
            (day.sessions ?? []).map((session, si) => (
              <View key={si} style={styles.sessionWrapper}>
                <ExerciseSection session={session} />

                {isStrengthSession(session) ? (
                  <StrengthLogCard
                    alreadySaved={strengthAlreadySaved}
                    saved={strengthSaved}
                    saving={strengthSaving}
                    values={strengthValues}
                    onChange={(field, v) =>
                      setStrengthValues(prev => ({ ...prev, [field]: v }))
                    }
                    onSave={() => saveStrengthResults(session.name)}
                  />
                ) : session.log_result ? (
                  <TrialLogCard
                    label={session.log_label}
                    value={trialValues[si] ?? ''}
                    saved={trialSaved[si] ?? false}
                    saving={trialSaving}
                    onChange={v => setTrialValues(prev => ({ ...prev, [si]: v }))}
                    onSave={() => saveTrialResult(si, session)}
                  />
                ) : (
                  <MarkCompleteCard
                    saved={completeSaved[si] ?? false}
                    saving={completeSaving}
                    onSave={() => markSessionComplete(si, session.name)}
                  />
                )}
              </View>
            ))
          )}
        </View>
      )}
    </View>
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

  const load = useCallback(async () => {
    setLoading(true);
    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) { setLoading(false); return; }
    setUserId(authData.user.id);

    const [progsRes, logsRes] = await Promise.all([
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
    ]);

    const progs = (progsRes.data ?? []) as Program[];
    setAllPrograms(progs);
    if (progs.length > 0) setWeekIdx(progs.length - 1);
    setTodayName(new Date().toLocaleDateString('en-US', { weekday: 'long' }));

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
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <ActivityIndicator color={YELLOW} style={{ flex: 1 }} />
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
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 60 }}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.heading}>MY PROGRAM</Text>

          {/* Week navigator */}
          <View style={styles.weekRow}>
            <TouchableOpacity
              onPress={() => setWeekIdx(i => i - 1)}
              disabled={!canGoBack}
              style={styles.weekArrow}
            >
              <Text style={[styles.weekArrowText, !canGoBack && styles.arrowDisabled]}>‹</Text>
            </TouchableOpacity>
            <Text style={styles.weekLabel}>Week {displayWeekNum}</Text>
            <TouchableOpacity
              onPress={() => setWeekIdx(i => i + 1)}
              disabled={!canGoForward}
              style={styles.weekArrow}
            >
              <Text style={[styles.weekArrowText, !canGoForward && styles.arrowDisabled]}>›</Text>
            </TouchableOpacity>
          </View>

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
  container: { flex: 1, backgroundColor: BLACK },
  heading: {
    color: OFF_WHITE, fontSize: 24, fontWeight: '800',
    paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8,
  },

  weekRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 24, paddingVertical: 12,
  },
  weekArrow:     { padding: 8 },
  weekArrowText: { color: OFF_WHITE, fontSize: 28, fontWeight: '300' },
  arrowDisabled: { color: '#333' },
  weekLabel:     { color: OFF_WHITE, fontSize: 17, fontWeight: '700', minWidth: 80, textAlign: 'center' },

  dayList:      { paddingHorizontal: 16, gap: 10 },
  dayCard:      { backgroundColor: CARD_BG, borderRadius: 14, overflow: 'hidden' },
  dayCardToday: { borderLeftWidth: 3, borderLeftColor: YELLOW },

  dayCardHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: 16,
  },
  dayCardLeft:  { flexDirection: 'row', alignItems: 'center' },
  dayCardRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dayName:      { color: OFF_WHITE, fontSize: 15, fontWeight: '700' },
  checkmark:    { color: GREEN, fontSize: 14 },
  sessionType:  { color: GREY, fontSize: 13 },
  chevron:      { color: GREY, fontSize: 12, marginLeft: 4 },

  expandedContent: { paddingHorizontal: 16, paddingBottom: 16, gap: 16 },
  sessionWrapper:  { gap: 12 },

  sessionBlock:     { gap: 10 },
  sessionHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  sessionName:      { color: OFF_WHITE, fontSize: 14, fontWeight: '700', flex: 1 },
  sessionMeta:      { color: GREY, fontSize: 12 },
  sessionDesc:      { color: GREY, fontSize: 13, lineHeight: 18 },

  section:      { gap: 8 },
  sectionLabel: {
    color: GREY, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase',
  },
  exRow:    { borderLeftWidth: 3, borderLeftColor: YELLOW, paddingLeft: 10, gap: 2 },
  exName:   { color: OFF_WHITE, fontSize: 14, fontWeight: '600' },
  exDetail: { color: GREY, fontSize: 13 },
  restNote: { color: GREY, fontSize: 14, fontStyle: 'italic' },
  emptyText:{ color: GREY, textAlign: 'center', marginTop: 40, fontSize: 15 },

  // Shared log card shell
  trialCard: {
    backgroundColor: '#111800', borderRadius: 10, padding: 14, gap: 10,
    borderLeftWidth: 3, borderLeftColor: YELLOW,
  },
  trialLabel:      { color: OFF_WHITE, fontSize: 13, fontWeight: '600' },
  trialInput:      {
    backgroundColor: '#1c1c1c', borderWidth: 1, borderColor: '#2a2a2a',
    borderRadius: 8, paddingHorizontal: 14, paddingVertical: 12,
    color: OFF_WHITE, fontSize: 18, fontWeight: '700',
  },
  trialBtn:        { backgroundColor: YELLOW, borderRadius: 8, paddingVertical: 13, alignItems: 'center' },
  trialBtnDisabled:{ opacity: 0.45 },
  trialBtnText:    { color: BLACK, fontSize: 14, fontWeight: '700' },

  completeConfirm:     { paddingVertical: 8, alignItems: 'center' },
  completeConfirmText: { color: YELLOW, fontSize: 14, fontWeight: '600' },

  trialSavedRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  trialSavedValue: { color: YELLOW, fontSize: 20, fontWeight: '700' },
  trialSavedBadge: { color: GREEN, fontSize: 12, fontWeight: '700' },

  // Strength lift rows
  liftRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 4,
  },
  liftName:      { color: OFF_WHITE, fontSize: 14, fontWeight: '500', flex: 1 },
  liftInput:     {
    backgroundColor: '#1c1c1c', borderWidth: 1, borderColor: '#2a2a2a',
    borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8,
    color: OFF_WHITE, fontSize: 16, fontWeight: '700',
    width: 80, textAlign: 'right',
  },
  liftSavedCell: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  liftSavedValue:{ color: YELLOW, fontSize: 16, fontWeight: '700' },
  liftSavedUnit: { color: GREY, fontSize: 12 },
  liftCheck:     { color: GREEN, fontSize: 13, fontWeight: '700' },
});
