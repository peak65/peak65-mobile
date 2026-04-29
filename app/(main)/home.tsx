import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  StyleSheet, ActivityIndicator, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '../../lib/supabase';
import type { Program, ProgramDay, ExerciseItem, ProgramSession } from '../_layout';

// ─── Constants ────────────────────────────────────────────────────────────────

const YELLOW    = '#e8ff47';
const BLACK     = '#080808';
const OFF_WHITE = '#f0ede8';
const GREY      = '#8a877f';
const CARD_BG   = '#111111';
const GREEN     = '#44ff88';
const RED       = '#ff4444';

const MILESTONES: Record<number, { emoji: string; message: string; sub: string }> = {
  1:   { emoji: '🏆', message: 'First one down. The journey starts now.', sub: 'Session 1 complete.' },
  5:   { emoji: '🔥', message: '5 sessions. Consistency is forming.',      sub: 'Keep showing up.' },
  10:  { emoji: '⚡', message: '10 sessions. You\'re building something real.', sub: 'Double digits.' },
  25:  { emoji: '💪', message: '25 sessions. You\'re not who you were.',   sub: 'A quarter century.' },
  50:  { emoji: '🚀', message: '50 sessions. Half way to triple digits.',  sub: 'Unstoppable.' },
  100: { emoji: '👑', message: '100 sessions. Elite mindset. Proven.',     sub: 'Triple digits.' },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayLabel() {
  return new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function scoreColor(s: number) {
  if (s >= 80) return GREEN;
  if (s >= 50) return YELLOW;
  return RED;
}

function fmtSeconds(s: number) {
  const m   = Math.floor(s / 60).toString().padStart(2, '0');
  const sec = (s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

function weekNumber(weekStartDate: string | undefined): number {
  if (!weekStartDate) return 1;
  return Math.max(1,
    Math.floor((Date.now() - new Date(weekStartDate + 'T00:00:00').getTime()) / (7 * 86_400_000)) + 1
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ExerciseRow({ ex, highlight }: { ex: ExerciseItem; highlight?: boolean }) {
  let detail = '';
  if (ex.sets && ex.reps) detail = `${ex.sets} × ${ex.reps}`;
  else if (ex.reps) detail = ex.reps;
  else if (ex.distance || ex.zone || ex.duration) {
    detail = [ex.distance, ex.zone, ex.duration].filter(Boolean).join(' • ');
  }
  const note = ex.notes || ex.note;
  return (
    <View style={[styles.exRow, { borderLeftColor: highlight ? YELLOW : GREY }]}>
      <Text style={styles.exName}>{ex.name}</Text>
      {!!detail && <Text style={styles.exDetail}>{detail}</Text>}
      {!!note  && <Text style={styles.exDetail}>{note}</Text>}
    </View>
  );
}

function SectionBlock({ label, items, highlight }: { label: string; items: ExerciseItem[]; highlight?: boolean }) {
  if (!items?.length) return null;
  return (
    <View style={styles.sectionBlock}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {items.map((ex, i) => <ExerciseRow key={i} ex={ex} highlight={highlight} />)}
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

  // Non-trial session flow
  const [sessionPhase, setSessionPhase]       = useState<'idle' | 'active' | 'saving' | 'done'>('idle');
  const [sessionStartTime, setSessionStartTime] = useState(0);
  const [elapsed, setElapsed]                 = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Trial result logging (per session index)
  const [trialValues, setTrialValues] = useState<Record<number, string>>({});
  const [trialSaved, setTrialSaved]   = useState<Record<number, boolean>>({});
  const [trialSaving, setTrialSaving] = useState(false);

  // Milestone
  const [milestone, setMilestone] = useState<(typeof MILESTONES)[number] | null>(null);

  // Week 2 generation
  const [generatingWeek2, setGeneratingWeek2] = useState(false);
  const [week2Ready, setWeek2Ready]           = useState(false);
  const [week2Exists, setWeek2Exists]         = useState(false);
  const week2TriggeredRef = useRef(false);

  // ── Load data ────────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    setLoading(true);
    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) { setLoading(false); return; }
    setUserId(authData.user.id);

    const todayStr = new Date().toLocaleDateString('en-US', { weekday: 'long' });

    const [progsRes, logsRes] = await Promise.all([
      supabase.from('programs').select('*').eq('user_id', authData.user.id)
        .order('week_number', { ascending: true }),
      supabase.from('session_logs').select('completed_at')
        .eq('user_id', authData.user.id).order('completed_at', { ascending: false }),
    ]);

    const progs = (progsRes.data ?? []) as Program[];

    // Show today's day from whichever week currently contains today
    let activeProg: Program | null = null;
    for (const p of progs) {
      const start = new Date(p.week_start_date + 'T00:00:00');
      const end   = new Date(start.getTime() + 7 * 86_400_000);
      const now   = new Date();
      if (now >= start && now < end) { activeProg = p; break; }
    }
    // Fallback: latest program
    if (!activeProg && progs.length > 0) activeProg = progs[progs.length - 1];

    const prog = activeProg;
    setProgram(prog);

    if (prog?.program_data?.days) {
      setTodayDay(prog.program_data.days.find(d => d.day === todayStr) ?? null);
    }

    const week2 = progs.some(p => p.week_number === 2);
    setWeek2Exists(week2);

    const logs = logsRes.data ?? [];
    setSessionCount(logs.length);

    const dates = [...new Set(logs.map(l =>
      new Date(l.completed_at).toLocaleDateString('en-CA')))].sort().reverse();
    let s = 0;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (let i = 0; i < dates.length; i++) {
      const d    = new Date(dates[i] + 'T00:00:00');
      const diff = Math.floor((today.getTime() - d.getTime()) / 86_400_000);
      if (diff === i || diff === i + 1) s++;
      else break;
    }
    setStreak(s);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { loadData(); }, [loadData]));

  // ── Timer ────────────────────────────────────────────────────────────────────

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

  // ── Session actions ───────────────────────────────────────────────────────────

  function startSession() {
    setSessionStartTime(Date.now());
    setElapsed(0);
    setSessionPhase('active');
  }

  async function markComplete() {
    if (!userId || !program || !todayDay) return;
    setSessionPhase('saving');

    const wk = weekNumber(program.week_start_date);
    await supabase.from('session_logs').insert({
      user_id:      userId,
      program_id:   program.id,
      day_name:     todayDay.day,
      week_number:  wk,
      session_name: todayDay.sessions?.[0]?.name ?? null,
      duration:     elapsed,
      completed:    true,
      completed_at: new Date().toISOString(),
    });

    const newCount = sessionCount + 1;
    setSessionCount(newCount);
    if (MILESTONES[newCount]) setMilestone(MILESTONES[newCount]);
    setSessionPhase('done');
  }

  async function saveTrialResult(si: number, session: ProgramSession) {
    if (!userId || !program || !todayDay || !trialValues[si]?.trim()) return;
    setTrialSaving(true);

    const wk = weekNumber(program.week_start_date);
    await supabase.from('session_logs').insert({
      user_id:      userId,
      program_id:   program.id,
      day_name:     todayDay.day,
      week_number:  wk,
      session_name: session.name,
      log_field:    session.log_field ?? null,
      log_value:    trialValues[si].trim(),
      completed:    true,
      completed_at: new Date().toISOString(),
    });

    const newCount = sessionCount + 1;
    setSessionCount(newCount);
    if (MILESTONES[newCount]) setMilestone(MILESTONES[newCount]);

    const newTrialSaved = { ...trialSaved, [si]: true };
    setTrialSaved(newTrialSaved);
    setTrialSaving(false);

    // After saving, check if ALL trial sessions across the week are now logged
    if (program.week_number === 1 && !week2Exists && !week2TriggeredRef.current) {
      await checkAndTriggerWeek2(userId, program, newTrialSaved);
    }
  }

  async function checkAndTriggerWeek2(
    uid: string, prog: Program, latestSaved: Record<number, boolean>,
  ) {
    // Count trial sessions in the whole week 1 program
    const allTrialSessions = (prog.program_data?.days ?? [])
      .flatMap(d => d.sessions ?? [])
      .filter(s => s.log_result === true);
    if (allTrialSessions.length === 0) return;

    // Check how many trial logs exist in DB for week 1
    const { count } = await supabase
      .from('session_logs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', uid)
      .eq('week_number', 1)
      .not('log_value', 'is', null);

    if ((count ?? 0) < allTrialSessions.length) return;

    // All trials logged — generate week 2
    week2TriggeredRef.current = true;
    setGeneratingWeek2(true);
    try {
      const res = await fetch('https://peak65.vercel.app/api/generate-week2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: uid }),
      });
      if (res.ok) {
        setWeek2Exists(true);
        setWeek2Ready(true);
      }
    } catch (e) {
      console.log('[week2] generation error:', e);
    }
    setGeneratingWeek2(false);
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <ActivityIndicator color={YELLOW} style={{ flex: 1 }} />
      </SafeAreaView>
    );
  }

  const sessions      = todayDay?.sessions ?? [];
  const isRestDay     = todayDay?.type === 'rest' || sessions.length === 0;
  const allTrial      = sessions.length > 0 && sessions.every(s => s.log_result);
  const hasNonTrial   = sessions.some(s => !s.log_result);

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

        {/* ── TODAY ─────────────────────────────────────────────────────────── */}
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
          <>
            {sessions.map((session, si) => (
              <View key={si}>
                {/* Session header */}
                <View style={styles.sessionHeader}>
                  <Text style={styles.sessionName}>{session.name}</Text>
                  <Text style={styles.sessionMeta}>{session.time} · {session.duration_minutes} min</Text>
                </View>
                {!!session.description && (
                  <Text style={styles.sessionDesc}>{session.description}</Text>
                )}

                {/* Blocks */}
                <View style={styles.sessionCard}>
                  {(session.blocks ?? []).map((block, bi) => (
                    <SectionBlock
                      key={bi}
                      label={block.block_name}
                      items={block.exercises}
                      highlight={block.block_name.toLowerCase().includes('main')}
                    />
                  ))}
                </View>

                {/* Trial log input */}
                {session.log_result && (
                  <View style={styles.trialCard}>
                    <Text style={styles.trialLabel}>{session.log_label}</Text>
                    {trialSaved[si] ? (
                      <>
                        <Text style={styles.trialConfirm}>Result saved. Keep moving.</Text>
                        <View style={[styles.primaryBtn, { backgroundColor: GREEN }]}>
                          <Text style={styles.primaryBtnText}>✓ LOGGED</Text>
                        </View>
                      </>
                    ) : (
                      <>
                        <TextInput
                          style={styles.trialInput}
                          placeholder="e.g. 42:30"
                          placeholderTextColor={GREY}
                          value={trialValues[si] ?? ''}
                          onChangeText={v => setTrialValues(prev => ({ ...prev, [si]: v }))}
                          selectionColor={YELLOW}
                          autoCorrect={false}
                        />
                        <TouchableOpacity
                          style={[
                            styles.primaryBtn,
                            (!trialValues[si]?.trim() || trialSaving) && styles.btnDisabled,
                          ]}
                          onPress={() => saveTrialResult(si, session)}
                          disabled={!trialValues[si]?.trim() || trialSaving}
                        >
                          <Text style={styles.primaryBtnText}>
                            {trialSaving ? 'SAVING...' : 'LOG RESULT'}
                          </Text>
                        </TouchableOpacity>
                      </>
                    )}
                  </View>
                )}
              </View>
            ))}

            {/* Non-trial session controls */}
            {hasNonTrial && (
              sessionPhase === 'idle' ? (
                <TouchableOpacity style={styles.primaryBtn} onPress={startSession}>
                  <Text style={styles.primaryBtnText}>START SESSION</Text>
                </TouchableOpacity>
              ) : sessionPhase === 'active' ? (
                <View style={styles.activePanel}>
                  <Text style={styles.timerText}>⏱ {fmtSeconds(elapsed)}</Text>
                  <TouchableOpacity style={[styles.primaryBtn, { flex: 1 }]} onPress={markComplete}>
                    <Text style={styles.primaryBtnText}>MARK COMPLETE</Text>
                  </TouchableOpacity>
                </View>
              ) : sessionPhase === 'saving' ? (
                <View style={[styles.primaryBtn, styles.btnDisabled]}>
                  <Text style={styles.primaryBtnText}>SAVING...</Text>
                </View>
              ) : (
                /* done */
                <View style={styles.donePanel}>
                  <Text style={styles.doneText}>Session logged. Keep moving.</Text>
                </View>
              )
            )}
          </>
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

  // Score card
  scoreCard: {
    margin: 16, backgroundColor: CARD_BG, borderRadius: 16, padding: 24, alignItems: 'center',
  },
  scoreCardLabel: { color: GREY, fontSize: 11, fontWeight: '600', letterSpacing: 1.5, textTransform: 'uppercase' },
  scoreNum: { fontSize: 80, fontWeight: '800', lineHeight: 96 },
  scoreCoach: { color: OFF_WHITE, fontSize: 14, textAlign: 'center', marginTop: 4 },
  scoreWearable: { color: GREY, fontSize: 11, textAlign: 'center', marginTop: 8 },

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
  statSub: { color: GREY, fontSize: 10 },

  // Today
  todayHeader: {
    color: YELLOW, fontSize: 11, fontWeight: '700', letterSpacing: 1.5,
    textTransform: 'uppercase', paddingHorizontal: 20, marginTop: 8, marginBottom: 4,
  },
  emptyBlock: { paddingHorizontal: 20, paddingVertical: 24 },
  emptyText: { color: GREY, fontSize: 15, textAlign: 'center' },

  sessionHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline',
    paddingHorizontal: 20, marginBottom: 6,
  },
  sessionName: { color: OFF_WHITE, fontSize: 16, fontWeight: '700', flex: 1 },
  sessionMeta: { color: GREY, fontSize: 12 },
  sessionDesc: { color: GREY, fontSize: 13, paddingHorizontal: 20, marginBottom: 12, lineHeight: 18 },

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

  // Trial log card
  trialCard: {
    marginHorizontal: 16, marginBottom: 14, backgroundColor: CARD_BG,
    borderRadius: 16, padding: 16, gap: 12, borderLeftWidth: 3, borderLeftColor: YELLOW,
  },
  trialLabel: { color: OFF_WHITE, fontSize: 14, fontWeight: '600' },
  trialInput: {
    backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#2a2a2a',
    borderRadius: 10, paddingHorizontal: 16, paddingVertical: 14,
    color: OFF_WHITE, fontSize: 20, fontWeight: '700',
  },
  trialConfirm: { color: YELLOW, fontSize: 14, fontWeight: '600' },

  // Non-trial session controls
  activePanel: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    marginHorizontal: 16, marginBottom: 10,
  },
  timerText: { color: YELLOW, fontSize: 16, fontWeight: '700', minWidth: 60 },
  donePanel: {
    marginHorizontal: 16, marginBottom: 10,
    backgroundColor: '#0a1a0a', borderRadius: 12, paddingVertical: 16, alignItems: 'center',
    borderWidth: 1, borderColor: GREEN,
  },
  doneText: { color: GREEN, fontSize: 15, fontWeight: '700' },

  // Buttons
  primaryBtn: {
    backgroundColor: YELLOW, borderRadius: 12, paddingVertical: 16,
    alignItems: 'center', marginHorizontal: 16, marginBottom: 10,
  },
  primaryBtnText: { color: BLACK, fontSize: 16, fontWeight: '700' },
  btnDisabled: { opacity: 0.45 },

  // Milestone
  milestoneOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center', padding: 32,
  },
  milestoneCard: { alignItems: 'center', gap: 12, width: '100%' },
  milestoneEmoji: { fontSize: 64 },
  milestoneNum: { color: YELLOW, fontSize: 72, fontWeight: '800' },
  milestoneMsg: { color: OFF_WHITE, fontSize: 22, fontWeight: '700', textAlign: 'center' },
  milestoneSub: { color: GREY, fontSize: 15, textAlign: 'center', marginBottom: 16 },

  // Week 2 banner
  week2Banner: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: 16, marginTop: 8, marginBottom: 4,
    backgroundColor: CARD_BG, borderRadius: 14, padding: 16,
    borderLeftWidth: 3, borderLeftColor: YELLOW,
  },
  week2BannerReady: { borderLeftColor: GREEN },
  week2ReadyIcon: { fontSize: 22, marginRight: 10 },
  week2Title: { color: YELLOW, fontSize: 14, fontWeight: '700', marginBottom: 2 },
  week2Sub:   { color: GREY, fontSize: 12 },
});
