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

import { supabase } from '../../lib/supabase';
import type { MainStackParamList, ProgramDay, ProgramSession } from '../_layout';

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
  day_index: number;
  session_name: string;
  completed: boolean;
  completed_at: string | null;
  rpe: number | null;
  log_value: string | null;
  log_field: string | null;
  notes: string | null;
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
  dayIndex: number,
  weekStartDate: string,
  logs: SessionLogRow[],
): DayStatus {
  const logsForDay = logs.filter(l => l.day_index === dayIndex);
  if (logsForDay.some(l => l.completed)) return 'completed';

  const weekStart = new Date(weekStartDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayDate = new Date(weekStart);
  dayDate.setDate(weekStart.getDate() + dayIndex);
  return dayDate < today ? 'missed' : 'upcoming';
}

const TIER_LABELS: Record<string, string> = {
  elite:      'Elite',
  coached:    'Coached',
  ai_coached: 'AI Coached',
};

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function CoachAthleteScreen({ route, navigation }: Props) {
  const { athleteId } = route.params;

  const [profile, setProfile]           = useState<Profile | null>(null);
  const [program, setProgram]           = useState<{ id: string; week_number: number; week_start_date: string; days: ProgramDay[] } | null>(null);
  const [sessionLogs, setSessionLogs]   = useState<SessionLogRow[]>([]);
  const [scores, setScores]             = useState<ScoreRow[]>([]);
  const [messages, setMessages]         = useState<MessageRow[]>([]);
  const [notes, setNotes]               = useState('');
  const [coachAthleteId, setCoachAthleteId] = useState<string | null>(null);
  const [coachId, setCoachId]           = useState<string | null>(null);
  const [messageText, setMessageText]   = useState('');
  const [sending, setSending]           = useState(false);
  const [loading, setLoading]           = useState(true);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);

  const notesTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesRef  = useRef<ScrollView>(null);
  const mounted      = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!mounted.current) return;
    if (!user) return;
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
        .select('id, week_number, week_start_date, program_data')
        .eq('user_id', athleteId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (!mounted.current) return;
    setProfile(profileRes.data ?? null);

    if (caRes.data) {
      setCoachAthleteId(caRes.data.id);
      setNotes(caRes.data.notes ?? '');
    }

    const prog = programRes.data;
    if (prog) {
      const days: ProgramDay[] = prog.program_data?.days ?? [];
      setProgram({ id: prog.id, week_number: prog.week_number, week_start_date: prog.week_start_date, days });

      // Session logs for this program week
      const logsRes = await supabase
        .from('session_logs')
        .select('id, day_index, session_name, completed, completed_at, rpe, log_value, log_field, notes')
        .eq('user_id', athleteId)
        .eq('week_number', prog.week_number);
      if (!mounted.current) return;
      setSessionLogs(logsRes.data ?? []);
    }

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
                  <Text style={styles.metaChip}>Week {program.week_number}</Text>
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
                const status = getDayStatus(day.day_index ?? i, program.week_start_date, sessionLogs);
                const logsForDay = sessionLogs.filter(l => l.day_index === (day.day_index ?? i));
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
                      <StatusBadge status={status} />
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
            <Text style={styles.sectionTitle}>65 Score — Last 7 Days</Text>
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
                  <Text style={styles.overviewDay}>{day.day}</Text>
                  <Text style={styles.overviewSession} numberOfLines={1}>
                    {day.is_rest
                      ? 'Rest'
                      : day.sessions[0]?.name ?? '—'}
                  </Text>
                  <Text style={styles.overviewType}>{day.type}</Text>
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
              {block.exercises?.map((ex, ei) => (
                <Text key={ei} style={styles.detailExercise}>
                  {ex.name}
                  {ex.sets ? `  ${ex.sets}×${ex.reps ?? ''}` : ''}
                  {ex.distance ? `  ${ex.distance}` : ''}
                  {ex.zone ? `  Z${ex.zone}` : ''}
                </Text>
              ))}
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

  // ── 65 Score chart
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
    width: 36,
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
