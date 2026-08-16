import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';

import { supabase } from '../../lib/supabase';
import type { MainStackParamList, ProgramDay, ProgramSession, ExerciseItem } from '../_layout';
import TrendLineChart from '../components/TrendLineChart';
import { groupBySuperset } from '../../lib/programGrouping';

type Props = NativeStackScreenProps<MainStackParamList, 'CoachAthleteDetail'>;

const YELLOW    = '#e8ff47';
const BLACK     = '#080808';
const OFF_WHITE = '#f0ede8';
const GREY      = '#8a877f';
const CARD_BG   = '#111111';
const GREEN     = '#44ff88';
const RED       = '#ff4444';
const DIM       = '#1a1a1a';
const ORANGE    = '#ff9944';

// ─── Types ────────────────────────────────────────────────────────────────────

type Profile = {
  id: string;
  first_name: string;
  last_name: string;
  avatar_url: string | null;
  goal: string | null;
  race_date: string | null;
  tier: string | null;
};

type SessionLogRow = {
  id: string;
  day_name: string | null;
  session_name: string;
  completed: boolean;
  completed_at: string | null;
  rpe: number | null;
  log_value: string | null;
  log_field: string | null;
  notes: string | null;
  was_modified: boolean | null;
  modification_note: string | null;
  // Pace execution. hit_target is null when the athlete was never asked —
  // an unpaced session, or a session logged before the feature existed.
  hit_target: boolean | null;
  actual_pace: string | null;
  miss_note: string | null;
  prescribed_pace: string | null;
};

type ProgramWeek = {
  id: string;
  week_number: number;
  week_start_date: string;
  days: ProgramDay[];
  phase: string | null;
};

type ScoreRow = {
  score: number;
  date: string;
};

type MessageRow = {
  id: string;
  sender_id: string;
  body: string;
  created_at: string;
};

type DayStatus = 'completed' | 'missed' | 'upcoming';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 80) return GREEN;
  if (score >= 60) return YELLOW;
  return RED;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function getLast7Days(): string[] {
  const days: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().split('T')[0]);
  }
  return days;
}

function dayOfWeekLabel(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 1);
}

function getDayStatus(
  dayName: string,
  dayIndex: number,
  weekStartDate: string,
  logs: SessionLogRow[],
): DayStatus {
  // Match logs by day_name — day_index is never written to session_logs (null in
  // every row), whereas day_name is reliably populated. dayIndex is still used
  // below to compute the day's calendar date for the missed/upcoming check.
  const logsForDay = logs.filter(l => l.day_name === dayName);
  if (logsForDay.some(l => l.completed)) return 'completed';

  const weekStart = new Date(weekStartDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayDate = new Date(weekStart);
  dayDate.setDate(weekStart.getDate() + dayIndex);
  return dayDate < today ? 'missed' : 'upcoming';
}

const TIER_LABELS: Record<string, string> = {
  elite:      'Pinnacle',
  coached:    'Performance',
  ai_coached: 'Foundation',
};

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function CoachAthleteScreen({ route, navigation }: Props) {
  const { athleteId } = route.params;

  const [profile, setProfile]           = useState<Profile | null>(null);
  const [weeks, setWeeks]               = useState<ProgramWeek[]>([]);
  const [selectedWeekIdx, setSelectedWeekIdx] = useState(0);
  const [sessionLogs, setSessionLogs]   = useState<SessionLogRow[]>([]);
  const [scores, setScores]             = useState<ScoreRow[]>([]);
  const [healthReadings, setHealthReadings] = useState<any[]>([]);
  const [messages, setMessages]         = useState<MessageRow[]>([]);
  const [notes, setNotes]               = useState('');
  const [coachAthleteId, setCoachAthleteId] = useState<string | null>(null);
  const [coachId, setCoachId]           = useState<string | null>(null);
  const [messageText, setMessageText]   = useState('');
  const [sending, setSending]           = useState(false);
  const [loading, setLoading]           = useState(true);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);

  // Currently-displayed week, derived from the selected index. Defaults to the
  // latest week (set in load), so the screen opens on the current week as before.
  const program = weeks[selectedWeekIdx] ?? null;
  const selectedWeekNumber = program?.week_number ?? null;

  const notesTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesRef  = useRef<ScrollView>(null);
  const mounted      = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!mounted.current) return;
    if (!session?.user) return;
    const user = session.user;
    setCoachId(user.id);

    // Fetch profile, coach_athletes row, and latest program in parallel
    const [profileRes, caRes, programRes] = await Promise.all([
      supabase
        .from('profiles')
        .select('id, first_name, last_name, avatar_url, goal, race_date, tier')
        .eq('id', athleteId)
        .maybeSingle(),
      supabase
        .from('coach_athletes')
        .select('id, notes')
        .eq('athlete_id', athleteId)
        .eq('coach_id', user.id)
        .maybeSingle(),
      supabase
        .from('programs')
        .select('id, week_number, week_start_date, program_data, phase')
        .eq('user_id', athleteId)
        .not('is_draft', 'is', true)
        .order('week_number', { ascending: true }),
    ]);

    if (!mounted.current) return;
    setProfile(profileRes.data ?? null);

    if (caRes.data) {
      setCoachAthleteId(caRes.data.id);
      setNotes(caRes.data.notes ?? '');
    }

    // All non-draft weeks, ascending by week_number. Default the selected week to
    // the latest (last in the ascending list) so the initial view is unchanged.
    // Session logs for the selected week are loaded by a dedicated effect below.
    const mappedWeeks: ProgramWeek[] = (programRes.data ?? []).map((p: any) => ({
      id:              p.id,
      week_number:     p.week_number,
      week_start_date: p.week_start_date,
      days:            (p.program_data?.days ?? []) as ProgramDay[],
      phase:           p.phase ?? p.program_data?.phase ?? null,
    }));
    setWeeks(mappedWeeks);
    setSelectedWeekIdx(mappedWeeks.length > 0 ? mappedWeeks.length - 1 : 0);

    // 65 scores (last 7 days) — graceful fallback if table doesn't exist
    const sevenAgo = new Date();
    sevenAgo.setDate(sevenAgo.getDate() - 6);
    const scoreRes = await supabase
      .from('sixty_five_scores')
      .select('score, date')
      .eq('user_id', athleteId)
      .gte('date', sevenAgo.toISOString().split('T')[0])
      .order('date', { ascending: true });
    if (!mounted.current) return;
    if (!scoreRes.error) setScores(scoreRes.data ?? []);

    // Health readings (last 30 days) — RLS now permits a coach to read their athletes'
    const thirtyAgo = new Date();
    thirtyAgo.setDate(thirtyAgo.getDate() - 29);
    const healthRes = await supabase
      .from('daily_health_readings')
      .select('hrv, resting_hr, sleep_hours, reading_date')
      .eq('user_id', athleteId)
      .gte('reading_date', thirtyAgo.toISOString().split('T')[0])
      .order('reading_date', { ascending: true });
    if (!mounted.current) return;
    if (!healthRes.error) setHealthReadings(healthRes.data ?? []);

    // Messages thread
    const msgRes = await supabase
      .from('messages')
      .select('id, sender_id, body, created_at')
      .eq('coach_id', user.id)
      .eq('athlete_id', athleteId)
      .order('created_at', { ascending: true });
    if (!mounted.current) return;
    if (!msgRes.error) setMessages(msgRes.data ?? []);

    // Mark athlete messages as read
    await supabase
      .from('messages')
      .update({ read_at: new Date().toISOString() })
      .eq('coach_id', user.id)
      .eq('athlete_id', athleteId)
      .eq('sender_id', athleteId)
      .is('read_at', null);
  }, [athleteId]);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  // Re-query session logs whenever the selected week changes, so completion and
  // HR data follow the week currently shown.
  useEffect(() => {
    if (selectedWeekNumber == null) { setSessionLogs([]); return; }
    let active = true;
    (async () => {
      const logsRes = await supabase
        .from('session_logs')
        .select('id, day_name, session_name, completed, completed_at, rpe, log_value, log_field, notes, was_modified, modification_note, hit_target, actual_pace, miss_note, prescribed_pace')
        .eq('user_id', athleteId)
        .eq('week_number', selectedWeekNumber);
      if (logsRes.error) {
        console.error('[coach-athlete] session_logs query failed:', logsRes.error);
      }
      if (active && mounted.current) setSessionLogs(logsRes.data ?? []);
    })();
    return () => { active = false; };
  }, [athleteId, selectedWeekNumber]);

  // Auto-save notes after 2 s of inactivity
  function handleNotesChange(text: string) {
    setNotes(text);
    if (notesTimer.current) clearTimeout(notesTimer.current);
    if (!coachAthleteId) return;
    notesTimer.current = setTimeout(() => {
      supabase
        .from('coach_athletes')
        .update({ notes: text })
        .eq('id', coachAthleteId)
        .then(() => {});
    }, 2000);
  }

  async function sendMessage() {
    if (!messageText.trim() || !coachId) return;
    setSending(true);
    const body = messageText.trim();
    setMessageText('');
    const { data: newMsg } = await supabase
      .from('messages')
      .insert({ coach_id: coachId, athlete_id: athleteId, sender_id: coachId, body })
      .select('id, sender_id, body, created_at')
      .maybeSingle();
    if (newMsg) setMessages(prev => [...prev, newMsg]);
    setSending(false);
    setTimeout(() => messagesRef.current?.scrollToEnd({ animated: true }), 100);
  }

  // ─── Loading skeleton ──────────────────────────────────────────────────────

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>‹ Back</Text>
        </TouchableOpacity>
        <View style={styles.skeletonPage}>
          <View style={styles.skeletonHero} />
          <View style={styles.skeletonBlock} />
          <View style={styles.skeletonBlock} />
        </View>
      </SafeAreaView>
    );
  }

  const fullName  = `${profile?.first_name ?? ''} ${profile?.last_name ?? ''}`.trim();
  const tierLabel = TIER_LABELS[profile?.tier ?? ''] ?? profile?.tier ?? '';
  const last7     = getLast7Days();
  const scoreByDate = Object.fromEntries(scores.map(s => [s.date, s]));

  // Health trend data (30 days) — nulls preserved; TrendLineChart is gap-tolerant.
  const hrvData   = healthReadings.map(r => ({ date: r.reading_date, value: r.hrv ?? null }));
  const rhrData   = healthReadings.map(r => ({ date: r.reading_date, value: r.resting_hr ?? null }));
  const sleepData = healthReadings.map(r => ({ date: r.reading_date, value: r.sleep_hours ?? null }));

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Back button */}
      <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
        <Text style={styles.backText}>‹ Athletes</Text>
      </TouchableOpacity>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >

          {/* ── 1. HEADER ─────────────────────────────────────────────────── */}
          <View style={styles.section}>
            <View style={styles.headerCard}>
              <Text style={styles.heroName}>{fullName}</Text>
              {tierLabel !== '' && (
                <View style={styles.tierBadge}>
                  <Text style={styles.tierText}>{tierLabel}</Text>
                </View>
              )}
              <View style={styles.headerMeta}>
                {program && (
                  <View style={styles.weekNav}>
                    <TouchableOpacity
                      onPress={() => setSelectedWeekIdx(i => Math.max(0, i - 1))}
                      disabled={selectedWeekIdx <= 0}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <ChevronLeft size={18} color={selectedWeekIdx <= 0 ? GREY : YELLOW} />
                    </TouchableOpacity>
                    <Text style={styles.weekNavLabel}>Week {program.week_number}</Text>
                    <TouchableOpacity
                      onPress={() => setSelectedWeekIdx(i => Math.min(weeks.length - 1, i + 1))}
                      disabled={selectedWeekIdx >= weeks.length - 1}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <ChevronRight size={18} color={selectedWeekIdx >= weeks.length - 1 ? GREY : YELLOW} />
                    </TouchableOpacity>
                  </View>
                )}
                {program?.phase === 'reset' && (
                  <Text style={[styles.metaChip, { color: '#8a877f' }]}>RESET</Text>
                )}
                {profile?.race_date && profile?.goal === 'hyrox' && (
                  <Text style={styles.metaChip}>Race {fmtDate(profile.race_date)}</Text>
                )}
              </View>
            </View>
          </View>

          {/* ── 2. THIS WEEK ──────────────────────────────────────────────── */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>This Week</Text>
            {!program ? (
              <Text style={styles.emptyText}>No program yet.</Text>
            ) : (
              program.days.map((day, i) => {
                const status = getDayStatus(day.day, day.day_index ?? i, program.week_start_date, sessionLogs);
                // Reset weeks are intentionally optional — downgrade a 'missed' day to
                // the calm 'upcoming' (grey ·) state. Completed days stay green ✓.
                const shownStatus = (program.phase === 'reset' && status === 'missed') ? 'upcoming' : status;
                const logsForDay = sessionLogs.filter(l => l.day_name === day.day);
                const expanded = expandedSession === `day-${i}`;

                return (
                  <View key={i}>
                    <TouchableOpacity
                      style={styles.sessionRow}
                      onPress={() => setExpandedSession(expanded ? null : `day-${i}`)}
                      activeOpacity={0.7}
                    >
                      <View style={styles.sessionLeft}>
                        <Text style={styles.sessionDay}>{day.day}</Text>
                        <Text style={styles.sessionName} numberOfLines={1}>
                          {day.sessions[0]?.name ?? (day.is_rest ? 'Rest' : '—')}
                        </Text>
                      </View>
                      <View style={styles.sessionRight}>
                        {logsForDay.some(l => l.was_modified) && (
                          <View style={styles.modifiedChip}>
                            <Text style={styles.modifiedChipText}>Modified</Text>
                          </View>
                        )}
                        {/* Missed target — strictly === false, so an unpaced
                            session (null) never flags. */}
                        {logsForDay.some(l => l.hit_target === false) && (
                          <View style={styles.missedChip}>
                            <Text style={styles.missedChipText}>Missed</Text>
                          </View>
                        )}
                        <StatusBadge status={shownStatus} />
                      </View>
                    </TouchableOpacity>

                    {expanded && (
                      <SessionDetail
                        day={day}
                        logs={logsForDay}
                      />
                    )}
                  </View>
                );
              })
            )}
          </View>

          {/* ── 3. 65 SCORE TREND ─────────────────────────────────────────── */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Peak Score — Last 7 Days</Text>
            <View style={styles.chartCard}>
              <View style={styles.chartBars}>
                {last7.map(date => {
                  const entry = scoreByDate[date];
                  const barH   = entry ? Math.max(6, Math.round((entry.score / 100) * 72)) : 6;
                  const barCol = entry ? scoreColor(entry.score) : '#2a2a2a';
                  return (
                    <View key={date} style={styles.chartCol}>
                      <Text style={styles.chartLabel}>
                        {entry ? String(entry.score) : '--'}
                      </Text>
                      <View style={[styles.bar, { height: barH, backgroundColor: barCol }]} />
                      <Text style={styles.chartDay}>{dayOfWeekLabel(date)}</Text>
                    </View>
                  );
                })}
              </View>
            </View>
          </View>

          {/* ── 3b. HEALTH TRENDS (30 days) ───────────────────────────────── */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>HRV — Last 30 Days</Text>
            <View style={styles.chartCard}>
              <TrendLineChart data={hrvData} color={YELLOW} unit=" ms" label="HRV" />
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Resting HR — Last 30 Days</Text>
            <View style={styles.chartCard}>
              <TrendLineChart data={rhrData} color="#5b8def" unit=" bpm" label="RHR" />
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Sleep — Last 30 Days</Text>
            <View style={styles.chartCard}>
              <TrendLineChart data={sleepData} color={GREEN} unit=" h" label="Sleep" formatValue={(v) => v.toFixed(1)} />
            </View>
          </View>

          {/* ── 4. MESSAGES ───────────────────────────────────────────────── */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Messages</Text>
            <View style={styles.chatCard}>
              <ScrollView
                ref={messagesRef}
                style={styles.chatScroll}
                contentContainerStyle={styles.chatContent}
                onContentSizeChange={() => messagesRef.current?.scrollToEnd({ animated: false })}
                nestedScrollEnabled
              >
                {messages.length === 0 && (
                  <Text style={styles.emptyText}>No messages yet.</Text>
                )}
                {messages.map(m => {
                  const isCoachMsg = m.sender_id === coachId;
                  return (
                    <View
                      key={m.id}
                      style={[
                        styles.bubble,
                        isCoachMsg ? styles.bubbleCoach : styles.bubbleAthlete,
                      ]}
                    >
                      <Text style={isCoachMsg ? styles.bubbleTextCoach : styles.bubbleTextAthlete}>
                        {m.body}
                      </Text>
                      <Text style={styles.bubbleTime}>{fmtTime(m.created_at)}</Text>
                    </View>
                  );
                })}
              </ScrollView>

              <View style={styles.chatInputRow}>
                <TextInput
                  style={styles.chatInput}
                  placeholder="Message…"
                  placeholderTextColor="#555"
                  value={messageText}
                  onChangeText={setMessageText}
                  multiline
                  maxLength={2000}
                  returnKeyType="default"
                />
                <TouchableOpacity
                  style={[styles.sendBtn, (!messageText.trim() || sending) && styles.sendBtnDisabled]}
                  onPress={sendMessage}
                  disabled={!messageText.trim() || sending}
                >
                  {sending
                    ? <ActivityIndicator size="small" color={BLACK} />
                    : <Text style={styles.sendBtnText}>Send</Text>
                  }
                </TouchableOpacity>
              </View>
            </View>
          </View>

          {/* ── 5. NOTES ──────────────────────────────────────────────────── */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Notes</Text>
            <View style={styles.notesCard}>
              <TextInput
                style={styles.notesInput}
                placeholder="Private notes about this athlete…"
                placeholderTextColor="#444"
                value={notes}
                onChangeText={handleNotesChange}
                multiline
                textAlignVertical="top"
              />
            </View>
          </View>

          {/* ── 6. PROGRAM OVERVIEW ───────────────────────────────────────── */}
          <View style={[styles.section, { paddingBottom: 40 }]}>
            <Text style={styles.sectionTitle}>Program Overview</Text>
            {!program ? (
              <Text style={styles.emptyText}>No program yet.</Text>
            ) : (
              program.days.map((day, i) => (
                <View key={i} style={styles.overviewRow}>
                  <Text style={styles.overviewDay} numberOfLines={1}>{day.day}</Text>
                  <Text style={styles.overviewSession} numberOfLines={1}>
                    {day.is_rest
                      ? 'Rest'
                      : day.sessions[0]?.name ?? '—'}
                  </Text>
                  <Text style={styles.overviewType}>{day.type === 'race' ? 'Race' : day.type}</Text>
                </View>
              ))
            )}
          </View>

        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: DayStatus }) {
  const config = {
    completed: { color: GREEN,  label: '✓' },
    missed:    { color: RED,    label: '✗' },
    upcoming:  { color: GREY,   label: '·' },
  }[status];
  return (
    <View style={[styles.statusBadge, { borderColor: config.color }]}>
      <Text style={[styles.statusText, { color: config.color }]}>{config.label}</Text>
    </View>
  );
}

// " · 6:30/mi" when the log recorded what was prescribed, '' otherwise. Kept
// separate so a hit with no stored target still reads as a clean "Hit target".
function paceSuffix(log: SessionLogRow): string {
  const target = log.prescribed_pace?.trim();
  return target ? ` · ${target}` : '';
}

// The coach-facing summary of a missed target: what was asked, what the athlete
// actually hit, and why. Any missing piece is omitted rather than rendered
// blank — older logs may carry only some of them. Falls back to the same
// "no detail given" phrasing the Modified line already uses.
function missSummary(log: SessionLogRow): string {
  const parts: string[] = [];
  const target = log.prescribed_pace?.trim();
  const actual = log.actual_pace?.trim();
  if (target) parts.push(`target ${target}`);
  if (actual) parts.push(`ran ${actual}`);
  const head = parts.join(' · ');
  const why = log.miss_note?.trim();
  if (head && why) return `${head} — ${why}`;
  if (head) return head;
  if (why) return why;
  return 'Athlete missed the target (no detail given).';
}

// One exercise line in the coach view's compact style. Preserves the existing
// sets×reps / distance / zone formatting; `prefix` carries superset letters or
// an EMOM time window.
function coachExerciseLine(ex: ExerciseItem, key: React.Key, prefix?: string) {
  return (
    <Text key={key} style={styles.detailExercise}>
      {prefix ? `${prefix} ` : ''}{ex.name}
      {ex.sets ? `  ${ex.sets}×${ex.reps ?? ''}` : ''}
      {ex.distance ? `  ${ex.distance}` : ''}
      {ex.zone ? `  Z${ex.zone}` : ''}
    </Text>
  );
}

function SessionDetail({ day, logs }: { day: ProgramDay; logs: SessionLogRow[] }) {
  const sessions: ProgramSession[] = day.sessions ?? [];
  const completedLog = logs.find(l => l.completed);

  return (
    <View style={styles.sessionDetail}>
      {sessions.map((s, si) => (
        <View key={si} style={styles.detailSession}>
          <Text style={styles.detailSessionName}>{s.name}</Text>
          {s.blocks?.map((block, bi) => (
            <View key={bi} style={styles.detailBlock}>
              {block.block_name !== '' && (
                <Text style={styles.detailBlockName}>{block.block_name}</Text>
              )}
              {groupBySuperset(block.exercises ?? []).map((group, gi) => {
                if (group.kind === 'circuit' || group.kind === 'part-circuit') {
                  const timeCap = (group.members[0]?.ex as any)?.time_cap;
                  return (
                    <View key={gi} style={styles.detailGroup}>
                      {group.kind === 'part-circuit' && group.blockName ? (
                        <Text style={styles.detailSubBlockName}>{group.blockName}</Text>
                      ) : null}
                      <Text style={styles.detailGroupHeader}>
                        {timeCap ? `${timeCap} AMRAP:` : `${group.rounds} Rounds:`}
                      </Text>
                      {group.members.map((m, mi) => coachExerciseLine(m.ex, mi))}
                      {!!group.rest && (
                        <Text style={styles.detailRest}>{group.rest} rest between rounds</Text>
                      )}
                    </View>
                  );
                }
                if (group.kind === 'emom' || group.kind === 'part-emom') {
                  const header = `${(group.label ?? 'EMOM').toUpperCase()}${group.rounds ? ` · ${group.rounds} ROUNDS` : ''}`;
                  return (
                    <View key={gi} style={styles.detailGroup}>
                      {group.kind === 'part-emom' && group.blockName ? (
                        <Text style={styles.detailSubBlockName}>{group.blockName}</Text>
                      ) : null}
                      <Text style={styles.detailGroupHeader}>{header}</Text>
                      {group.members.map((m, mi) => coachExerciseLine(m.ex, mi, m.ex.time_window ?? undefined))}
                    </View>
                  );
                }
                if (group.kind === 'amrap' || group.kind === 'part-amrap') {
                  const header = `${(group.label ?? 'AMRAP').toUpperCase()}${group.timeCap ? ` · ${group.timeCap} MIN` : ''}`;
                  return (
                    <View key={gi} style={styles.detailGroup}>
                      {group.kind === 'part-amrap' && group.blockName ? (
                        <Text style={styles.detailSubBlockName}>{group.blockName}</Text>
                      ) : null}
                      <Text style={styles.detailGroupHeader}>{header}</Text>
                      {group.members.map((m, mi) => coachExerciseLine(m.ex, mi, m.ex.time_window ?? undefined))}
                    </View>
                  );
                }
                if (group.kind === 'superset' || group.kind === 'part-superset') {
                  return (
                    <View key={gi} style={styles.detailGroup}>
                      {group.kind === 'part-superset' && group.blockName ? (
                        <Text style={styles.detailSubBlockName}>{group.blockName}</Text>
                      ) : null}
                      {group.members.map((m, mi) => coachExerciseLine(m.ex, mi, `${String.fromCharCode(65 + mi)})`))}
                    </View>
                  );
                }
                if (group.kind === 'block') {
                  return (
                    <View key={gi} style={styles.detailGroup}>
                      {group.blockName ? (
                        <Text style={styles.detailSubBlockName}>{group.blockName}</Text>
                      ) : null}
                      {group.members.map((m, mi) => coachExerciseLine(m.ex, mi))}
                    </View>
                  );
                }
                // single
                return coachExerciseLine(group.ex, gi);
              })}
            </View>
          ))}
        </View>
      ))}
      {completedLog && (
        <View style={styles.detailLogRow}>
          {completedLog.log_value && (
            <Text style={styles.detailLogItem}>
              Result: <Text style={{ color: YELLOW }}>{completedLog.log_value}</Text>
            </Text>
          )}
          {completedLog.rpe !== null && (
            <Text style={styles.detailLogItem}>
              RPE: <Text style={{ color: YELLOW }}>{completedLog.rpe}</Text>
            </Text>
          )}
          {completedLog.notes && (
            <Text style={styles.detailLogItem}>
              Note: <Text style={{ color: OFF_WHITE }}>{completedLog.notes}</Text>
            </Text>
          )}
          {completedLog.was_modified && (
            <Text style={styles.detailLogItem}>
              <Text style={{ color: ORANGE, fontWeight: '700' }}>Modified: </Text>
              <Text style={{ color: OFF_WHITE }}>
                {completedLog.modification_note && completedLog.modification_note.trim() !== ''
                  ? completedLog.modification_note
                  : 'Athlete marked this session modified (no detail given).'}
              </Text>
            </Text>
          )}
          {/* Pace execution. Strict === checks: a null hit_target (unpaced
              session, or logged before this feature) renders nothing. */}
          {completedLog.hit_target === true && (
            <Text style={styles.detailLogItem}>
              <Text style={{ color: GREEN, fontWeight: '700' }}>Hit target</Text>
              <Text style={{ color: OFF_WHITE }}>{paceSuffix(completedLog)}</Text>
            </Text>
          )}
          {completedLog.hit_target === false && (
            <Text style={styles.detailLogItem}>
              <Text style={{ color: RED, fontWeight: '700' }}>Missed: </Text>
              <Text style={{ color: OFF_WHITE }}>{missSummary(completedLog)}</Text>
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BLACK,
  },
  backBtn: {
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  backText: {
    color: YELLOW,
    fontSize: 15,
    fontWeight: '600',
  },
  scrollContent: {
    paddingHorizontal: 16,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    color: GREY,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 10,
  },

  // ── Header
  headerCard: {
    backgroundColor: CARD_BG,
    borderRadius: 12,
    padding: 20,
    gap: 10,
  },
  heroName: {
    color: OFF_WHITE,
    fontSize: 26,
    fontWeight: '700',
  },
  tierBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#1e1e00',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  tierText: {
    color: YELLOW,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  headerMeta: {
    flexDirection: 'row',
    gap: 10,
    flexWrap: 'wrap',
  },
  metaChip: {
    color: GREY,
    fontSize: 13,
    backgroundColor: DIM,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  weekNav: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: DIM,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  weekNavLabel: {
    color: OFF_WHITE,
    fontSize: 13,
    fontWeight: '600',
    minWidth: 56,
    textAlign: 'center',
  },

  // ── This Week
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: CARD_BG,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 6,
  },
  sessionLeft: {
    flex: 1,
    gap: 2,
  },
  sessionRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  modifiedChip: {
    backgroundColor: 'rgba(255,153,68,0.12)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginLeft: 8,
  },
  modifiedChipText: {
    color: ORANGE,
    fontSize: 11,
    fontWeight: '700',
  },
  missedChip: {
    backgroundColor: 'rgba(255,68,68,0.12)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginLeft: 8,
  },
  missedChipText: {
    color: RED,
    fontSize: 11,
    fontWeight: '700',
  },
  sessionDay: {
    color: GREY,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sessionName: {
    color: OFF_WHITE,
    fontSize: 15,
    fontWeight: '500',
  },
  statusBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 12,
  },
  statusText: {
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 16,
  },

  // ── Session detail (expanded)
  sessionDetail: {
    backgroundColor: DIM,
    borderRadius: 10,
    padding: 14,
    marginBottom: 6,
    gap: 12,
  },
  detailSession: {
    gap: 8,
  },
  detailSessionName: {
    color: YELLOW,
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 4,
  },
  detailBlock: {
    gap: 3,
  },
  detailBlockName: {
    color: GREY,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  detailExercise: {
    color: OFF_WHITE,
    fontSize: 13,
    lineHeight: 18,
  },
  detailGroup: {
    gap: 2,
    marginTop: 2,
    paddingLeft: 8,
    borderLeftWidth: 2,
    borderLeftColor: '#2a2a2a',
  },
  detailGroupHeader: {
    color: YELLOW,
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 1,
  },
  detailSubBlockName: {
    color: GREY,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  detailRest: {
    color: GREY,
    fontSize: 12,
    fontStyle: 'italic',
  },
  detailLogRow: {
    borderTopWidth: 1,
    borderTopColor: '#2a2a2a',
    paddingTop: 10,
    gap: 4,
  },
  detailLogItem: {
    color: GREY,
    fontSize: 13,
  },

  // ── Peak Score chart
  chartCard: {
    backgroundColor: CARD_BG,
    borderRadius: 12,
    padding: 16,
  },
  chartBars: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: 110,
    gap: 4,
  },
  chartCol: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
  },
  chartLabel: {
    color: GREY,
    fontSize: 10,
    textAlign: 'center',
  },
  bar: {
    width: '100%',
    borderRadius: 3,
    minHeight: 6,
  },
  chartDay: {
    color: GREY,
    fontSize: 11,
    fontWeight: '600',
  },

  // ── Messages
  chatCard: {
    backgroundColor: CARD_BG,
    borderRadius: 12,
    overflow: 'hidden',
  },
  chatScroll: {
    maxHeight: 320,
  },
  chatContent: {
    padding: 14,
    gap: 8,
  },
  bubble: {
    maxWidth: '78%',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 14,
    gap: 3,
  },
  bubbleCoach: {
    backgroundColor: YELLOW,
    alignSelf: 'flex-end',
    borderBottomRightRadius: 4,
  },
  bubbleAthlete: {
    backgroundColor: DIM,
    alignSelf: 'flex-start',
    borderBottomLeftRadius: 4,
  },
  bubbleTextCoach: {
    color: BLACK,
    fontSize: 14,
    lineHeight: 19,
  },
  bubbleTextAthlete: {
    color: OFF_WHITE,
    fontSize: 14,
    lineHeight: 19,
  },
  bubbleTime: {
    color: '#00000055',
    fontSize: 10,
    alignSelf: 'flex-end',
  },
  chatInputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderTopWidth: 1,
    borderTopColor: '#1e1e1e',
    padding: 10,
    gap: 8,
  },
  chatInput: {
    flex: 1,
    backgroundColor: DIM,
    color: OFF_WHITE,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    maxHeight: 100,
  },
  sendBtn: {
    backgroundColor: YELLOW,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 60,
  },
  sendBtnDisabled: {
    opacity: 0.5,
  },
  sendBtnText: {
    color: BLACK,
    fontSize: 14,
    fontWeight: '700',
  },

  // ── Notes
  notesCard: {
    backgroundColor: CARD_BG,
    borderRadius: 12,
    padding: 14,
  },
  notesInput: {
    color: OFF_WHITE,
    fontSize: 14,
    lineHeight: 20,
    minHeight: 100,
  },

  // ── Program overview
  overviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: CARD_BG,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    marginBottom: 6,
    gap: 10,
  },
  overviewDay: {
    color: GREY,
    fontSize: 12,
    fontWeight: '600',
    width: 92,
    textTransform: 'uppercase',
  },
  overviewSession: {
    color: OFF_WHITE,
    fontSize: 14,
    flex: 1,
  },
  overviewType: {
    color: GREY,
    fontSize: 12,
  },

  // ── Skeleton
  skeletonPage: {
    padding: 16,
    gap: 16,
  },
  skeletonHero: {
    height: 100,
    backgroundColor: DIM,
    borderRadius: 12,
  },
  skeletonBlock: {
    height: 140,
    backgroundColor: DIM,
    borderRadius: 12,
  },

  emptyText: {
    color: GREY,
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 16,
  },
});
