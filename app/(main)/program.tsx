import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '../../lib/supabase';
import type { Program, ProgramDay, ExerciseItem, ProgramSession } from '../_layout';

const YELLOW    = '#e8ff47';
const BLACK     = '#080808';
const OFF_WHITE = '#f0ede8';
const GREY      = '#8a877f';
const CARD_BG   = '#111111';
const GREEN     = '#44ff88';

const INTENSITY_DOT: Record<string, string> = {
  easy: '🟢', moderate: '🟡', hard: '🔴', rest: '⚫',
};

function SessionCard({ session }: { session: ProgramSession }) {
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
              <View key={ei} style={[styles.exRow, { borderLeftColor: YELLOW }]}>
                <Text style={styles.exName}>{ex.name}</Text>
                {!!detail && <Text style={styles.exDetail}>{detail}</Text>}
                {!!note && <Text style={styles.exDetail}>{note}</Text>}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function DayCard({
  day, isToday, isComplete,
}: {
  day: ProgramDay; isToday: boolean; isComplete: boolean;
}) {
  const [expanded, setExpanded] = useState(isToday);
  const isRest = day.type === 'rest' || !day.sessions?.length;

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      style={[styles.dayCard, isToday && styles.dayCardToday]}
      onPress={() => setExpanded(e => !e)}
    >
      <View style={styles.dayCardHeader}>
        <View style={styles.dayCardLeft}>
          <Text style={[styles.dayName, isToday && { color: YELLOW }]}>
            {day.day}
          </Text>
          {isComplete && <Text style={styles.checkmark}> ✓</Text>}
        </View>
        <View style={styles.dayCardRight}>
          <Text style={styles.sessionType}>{day.type}</Text>
          <Text style={styles.chevron}>{expanded ? '▲' : '▼'}</Text>
        </View>
      </View>

      {expanded && (
        <View style={styles.expandedContent}>
          {isRest ? (
            <Text style={styles.restNote}>Rest — recover well.</Text>
          ) : (
            (day.sessions ?? []).map((session, si) => (
              <SessionCard key={si} session={session} />
            ))
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}

export default function ProgramScreen() {
  const [program, setProgram]           = useState<Program | null>(null);
  const [completedDays, setCompletedDays] = useState<Set<number>>(new Set());
  const [weekOffset, setWeekOffset]     = useState(0);
  const [todayName, setTodayName]       = useState('');
  const [loading, setLoading]           = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) { setLoading(false); return; }

    const [progRes, logsRes] = await Promise.all([
      supabase.from('programs').select('*')
        .eq('user_id', authData.user.id)
        .order('created_at', { ascending: false })
        .limit(1).maybeSingle(),
      supabase.from('session_logs').select('day_index, completed_at')
        .eq('user_id', authData.user.id),
    ]);

    const prog = progRes.data as Program | null;
    setProgram(prog);

    if (prog) {
      setTodayName(new Date().toLocaleDateString('en-US', { weekday: 'long' }));
    }

    // Which days have a log for the current week
    if (logsRes.data && prog?.week_start_date) {
      const weekStart = new Date(prog.week_start_date + 'T00:00:00');
      const weekEnd   = new Date(weekStart.getTime() + 7 * 86_400_000);
      const done = new Set(
        logsRes.data
          .filter(l => {
            const d = new Date(l.completed_at);
            return d >= weekStart && d < weekEnd;
          })
          .map(l => l.day_index as number)
      );
      setCompletedDays(done);
    }

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

  const weekNum = (program?.week_start_date
    ? Math.floor(
        (new Date().getTime() - new Date(program.week_start_date + 'T00:00:00').getTime())
        / (7 * 86_400_000)
      ) + 1
    : 1) + weekOffset;

  const days = program?.program_data?.days ?? [];

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
        <Text style={styles.heading}>MY PROGRAM</Text>

        {/* Week selector */}
        <View style={styles.weekRow}>
          <TouchableOpacity onPress={() => setWeekOffset(o => o - 1)}
            style={styles.weekArrow}>
            <Text style={styles.weekArrowText}>‹</Text>
          </TouchableOpacity>
          <Text style={styles.weekLabel}>Week {Math.max(1, weekNum)}</Text>
          <TouchableOpacity onPress={() => setWeekOffset(o => Math.min(0, o + 1))}
            style={styles.weekArrow}>
            <Text style={[styles.weekArrowText, weekOffset >= 0 && { color: '#333' }]}>›</Text>
          </TouchableOpacity>
        </View>

        {days.length === 0 ? (
          <Text style={styles.emptyText}>No program found.</Text>
        ) : (
          <View style={styles.dayList}>
            {days.map(day => (
              <DayCard
                key={day.day}
                day={day}
                isToday={weekOffset === 0 && day.day === todayName}
                isComplete={completedDays.has(day.day_index ?? -1)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

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
  weekArrow: { padding: 8 },
  weekArrowText: { color: OFF_WHITE, fontSize: 28, fontWeight: '300' },
  weekLabel: { color: OFF_WHITE, fontSize: 17, fontWeight: '700', minWidth: 80, textAlign: 'center' },

  dayList: { paddingHorizontal: 16, gap: 10 },
  dayCard: { backgroundColor: CARD_BG, borderRadius: 14, padding: 16 },
  dayCardToday: { borderLeftWidth: 3, borderLeftColor: YELLOW },

  dayCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  dayCardLeft: { flexDirection: 'row', alignItems: 'center' },
  dayCardRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dayName: { color: OFF_WHITE, fontSize: 15, fontWeight: '700' },
  checkmark: { color: GREEN, fontSize: 14 },
  intensityDot: { fontSize: 12 },
  sessionType: { color: GREY, fontSize: 13 },
  chevron: { color: GREY, fontSize: 12, marginLeft: 4 },

  expandedContent: { marginTop: 16, gap: 16 },

  sessionBlock: { gap: 10 },
  sessionHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  sessionName: { color: OFF_WHITE, fontSize: 14, fontWeight: '700', flex: 1 },
  sessionMeta: { color: GREY, fontSize: 12 },
  sessionDesc: { color: GREY, fontSize: 13, lineHeight: 18 },

  section: { gap: 8 },
  sectionLabel: {
    color: GREY, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase',
  },
  exRow: { borderLeftWidth: 3, paddingLeft: 10, gap: 2 },
  exName: { color: OFF_WHITE, fontSize: 14, fontWeight: '600' },
  exDetail: { color: GREY, fontSize: 13 },
  restNote: { color: GREY, fontSize: 14, fontStyle: 'italic' },
  emptyText: { color: GREY, textAlign: 'center', marginTop: 40, fontSize: 15 },
});
