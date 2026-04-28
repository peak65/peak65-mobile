import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  StyleSheet, ActivityIndicator, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '../../lib/supabase';

const YELLOW    = '#e8ff47';
const BLACK     = '#080808';
const OFF_WHITE = '#f0ede8';
const GREY      = '#8a877f';
const CARD_BG   = '#111111';
const BAR_MAX_H = 80;

// ─── Types ────────────────────────────────────────────────────────────────────

type Checkin = {
  id: string;
  created_at: string;
  weight: number | null;
  weight_unit: string | null;
  body_fat_percentage: number | null;
};

type SessionLog = {
  id: string;
  completed_at: string;
  day_index: number;
  rpe: number | null;
  duration: number | null;
};

// ─── Bar chart ────────────────────────────────────────────────────────────────

function BarChart({ values, labels, unit }: { values: number[]; labels: string[]; unit: string }) {
  if (!values.length) {
    return (
      <View style={styles.chartEmpty}>
        <Text style={styles.chartEmptyText}>No data yet.</Text>
      </View>
    );
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.barsRow}>
          {values.map((v, i) => {
            const h = ((v - min) / range) * BAR_MAX_H + 10;
            return (
              <View key={i} style={styles.barCol}>
                <Text style={styles.barVal}>{v % 1 === 0 ? v : v.toFixed(1)}</Text>
                <View style={[styles.bar, { height: h }]} />
                <Text style={styles.barLabel}>{labels[i]}</Text>
              </View>
            );
          })}
        </View>
      </ScrollView>
      <Text style={styles.barUnit}>{unit}</Text>
    </View>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
}

function fmtDuration(s: number | null): string {
  if (!s) return '';
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function rpeColor(rpe: number | null): string {
  if (!rpe) return GREY;
  if (rpe <= 3) return '#44ff88';
  if (rpe <= 6) return YELLOW;
  if (rpe <= 8) return '#ff9944';
  return '#ff4444';
}

function longestStreak(logs: SessionLog[]): number {
  const dates = [...new Set(logs.map(l =>
    new Date(l.completed_at).toLocaleDateString('en-CA')))]
    .sort().reverse();
  let max = 0, cur = 0;
  for (let i = 0; i < dates.length; i++) {
    if (i === 0) { cur = 1; max = 1; continue; }
    const prev = new Date(dates[i - 1] + 'T00:00:00');
    const curr = new Date(dates[i] + 'T00:00:00');
    const diff = Math.round((prev.getTime() - curr.getTime()) / 86_400_000);
    if (diff === 1) { cur++; max = Math.max(max, cur); }
    else cur = 1;
  }
  return max;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function HistoryScreen() {
  const [logs, setLogs]             = useState<SessionLog[]>([]);
  const [checkins, setCheckins]     = useState<Checkin[]>([]);
  const [profile, setProfile]       = useState<{ fitness_goal: string; weight_unit: string } | null>(null);
  const [loading, setLoading]       = useState(true);
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [activeTab, setActiveTab]   = useState<'weight' | 'bodyfat'>('weight');

  // Checkin form
  const [weightUnit, setWeightUnit] = useState<'lbs' | 'kg'>('lbs');
  const [weight, setWeight]         = useState('');
  const [bodyFat, setBodyFat]       = useState('');
  const [saving, setSaving]         = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) { setLoading(false); return; }

    const [profRes, logsRes, checkinsRes] = await Promise.all([
      supabase.from('profiles').select('fitness_goal, weight_unit').eq('id', authData.user.id).single(),
      supabase.from('session_logs').select('*').eq('user_id', authData.user.id)
        .order('completed_at', { ascending: false }),
      supabase.from('checkins').select('*').eq('user_id', authData.user.id)
        .order('created_at', { ascending: true }).limit(20),
    ]);

    setProfile(profRes.data);
    setLogs(logsRes.data ?? []);
    setCheckins(checkinsRes.data ?? []);
    if (profRes.data?.weight_unit) setWeightUnit(profRes.data.weight_unit as 'lbs' | 'kg');
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleSaveCheckin() {
    const w = parseFloat(weight);
    if (isNaN(w) || w <= 0) return;
    setSaving(true);
    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) { setSaving(false); return; }
    const bf = parseFloat(bodyFat);
    await supabase.from('checkins').insert({
      user_id: authData.user.id,
      weight: w,
      weight_unit: weightUnit,
      body_fat_percentage: !isNaN(bf) && bf > 0 ? bf : null,
    });
    setWeight(''); setBodyFat('');
    setSaving(false);
    setCheckinOpen(false);
    await load();
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <ActivityIndicator color={YELLOW} style={{ flex: 1 }} />
      </SafeAreaView>
    );
  }

  const showCheckin = !profile?.fitness_goal ||
    ['look_better', 'all_around'].includes(profile.fitness_goal);

  const totalSessions = logs.length;
  const best = longestStreak(logs);

  const weightCheckins = checkins.filter(c => c.weight != null);
  const bfCheckins     = checkins.filter(c => c.body_fat_percentage != null);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Check-in modal */}
      <Modal visible={checkinOpen} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Body Check-In</Text>

            <View style={styles.unitRow}>
              {(['lbs', 'kg'] as const).map(u => (
                <TouchableOpacity key={u}
                  style={[styles.unitBtn, weightUnit === u && styles.unitBtnActive]}
                  onPress={() => setWeightUnit(u)}>
                  <Text style={[styles.unitBtnText, weightUnit === u && { color: BLACK }]}>{u}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <TextInput style={styles.input} placeholder={`Weight (${weightUnit})`}
              placeholderTextColor={GREY} value={weight} onChangeText={setWeight}
              keyboardType="decimal-pad" selectionColor={YELLOW} />
            <TextInput style={[styles.input, { marginTop: 10 }]}
              placeholder="Body fat % (optional)"
              placeholderTextColor={GREY} value={bodyFat} onChangeText={setBodyFat}
              keyboardType="decimal-pad" selectionColor={YELLOW} />

            <TouchableOpacity
              style={[styles.saveBtn, (!parseFloat(weight) || saving) && { opacity: 0.4 }]}
              onPress={handleSaveCheckin} disabled={!parseFloat(weight) || saving}>
              <Text style={styles.saveBtnText}>{saving ? 'SAVING...' : 'SAVE CHECK-IN'}</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={() => setCheckinOpen(false)} style={{ marginTop: 12 }}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
        <Text style={styles.heading}>HISTORY</Text>

        {/* Stats summary */}
        <View style={styles.statsRow}>
          {[
            { label: 'Sessions', val: String(totalSessions) },
            { label: 'Best Streak', val: `${best}d` },
            { label: 'Total Miles', val: '--' },
          ].map(s => (
            <View key={s.label} style={styles.statCard}>
              <Text style={styles.statVal}>{s.val}</Text>
              <Text style={styles.statLabel}>{s.label}</Text>
            </View>
          ))}
        </View>

        {/* Check-in card */}
        {showCheckin && (
          <View style={styles.card}>
            <View style={styles.checkinCardRow}>
              <View>
                <Text style={styles.cardTitle}>📊 Body Check-In</Text>
                <Text style={styles.cardSub}>
                  Log your weight and body fat % to track progress
                </Text>
              </View>
              <TouchableOpacity style={styles.logBtn} onPress={() => setCheckinOpen(true)}>
                <Text style={styles.logBtnText}>LOG</Text>
              </TouchableOpacity>
            </View>

            {/* Chart */}
            {checkins.length > 0 && (
              <>
                <View style={styles.tabRow}>
                  {[
                    { key: 'weight', label: 'Weight' },
                    { key: 'bodyfat', label: 'Body Fat %' },
                  ].map(t => (
                    <TouchableOpacity key={t.key}
                      style={[styles.tab, activeTab === t.key && styles.tabActive]}
                      onPress={() => setActiveTab(t.key as 'weight' | 'bodyfat')}>
                      <Text style={[styles.tabText, activeTab === t.key && { color: BLACK }]}>
                        {t.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                {activeTab === 'weight' ? (
                  <BarChart
                    values={weightCheckins.map(c => c.weight as number)}
                    labels={weightCheckins.map(c => fmtDate(c.created_at))}
                    unit={weightUnit}
                  />
                ) : (
                  <BarChart
                    values={bfCheckins.map(c => c.body_fat_percentage as number)}
                    labels={bfCheckins.map(c => fmtDate(c.created_at))}
                    unit="%"
                  />
                )}
              </>
            )}
          </View>
        )}

        {/* Sessions list */}
        <Text style={styles.sectionHeading}>SESSIONS</Text>
        {logs.length === 0 ? (
          <Text style={styles.emptyText}>
            No sessions logged yet. Complete your first workout to start tracking.
          </Text>
        ) : (
          <View style={styles.logList}>
            {logs.map(log => (
              <View key={log.id} style={styles.logCard}>
                <View style={styles.logRow}>
                  <View>
                    <Text style={styles.logDate}>{fmtDate(log.completed_at)}</Text>
                    <Text style={styles.logType}>
                      {log.day_index !== null
                        ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][log.day_index] + ' Session'
                        : 'Session'}
                    </Text>
                  </View>
                  <View style={styles.logMeta}>
                    {log.duration != null && (
                      <Text style={styles.logDuration}>{fmtDuration(log.duration)}</Text>
                    )}
                    {log.rpe != null && (
                      <View style={[styles.rpeBadge, { backgroundColor: rpeColor(log.rpe) + '22' }]}>
                        <Text style={[styles.rpeBadgeText, { color: rpeColor(log.rpe) }]}>
                          RPE {log.rpe}
                        </Text>
                      </View>
                    )}
                  </View>
                </View>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BLACK },
  heading: { color: OFF_WHITE, fontSize: 24, fontWeight: '800', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12 },
  sectionHeading: {
    color: GREY, fontSize: 11, fontWeight: '700', letterSpacing: 1.5,
    textTransform: 'uppercase', paddingHorizontal: 20, marginTop: 20, marginBottom: 10,
  },
  emptyText: { color: GREY, fontSize: 14, textAlign: 'center', paddingHorizontal: 20, paddingVertical: 24 },

  statsRow: { flexDirection: 'row', paddingHorizontal: 16, gap: 10, marginBottom: 16 },
  statCard: { flex: 1, backgroundColor: CARD_BG, borderRadius: 12, padding: 14, alignItems: 'center' },
  statVal: { color: OFF_WHITE, fontSize: 22, fontWeight: '800', marginBottom: 2 },
  statLabel: { color: GREY, fontSize: 11, fontWeight: '600' },

  card: { marginHorizontal: 16, backgroundColor: CARD_BG, borderRadius: 14, padding: 16, marginBottom: 10 },
  checkinCardRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 },
  cardTitle: { color: OFF_WHITE, fontSize: 15, fontWeight: '700', marginBottom: 4 },
  cardSub: { color: GREY, fontSize: 12, maxWidth: '80%' },
  logBtn: { backgroundColor: YELLOW, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  logBtnText: { color: BLACK, fontSize: 12, fontWeight: '700' },

  // Chart tabs
  tabRow: {
    flexDirection: 'row', backgroundColor: '#1a1a1a', borderRadius: 8,
    padding: 3, gap: 3, marginBottom: 12,
  },
  tab: { flex: 1, paddingVertical: 7, alignItems: 'center', borderRadius: 6 },
  tabActive: { backgroundColor: YELLOW },
  tabText: { color: GREY, fontSize: 13, fontWeight: '600' },

  // Chart
  chartEmpty: { paddingVertical: 20, alignItems: 'center' },
  chartEmptyText: { color: GREY, fontSize: 13 },
  barsRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingBottom: 4, minHeight: BAR_MAX_H + 40 },
  barCol: { width: 44, alignItems: 'center', gap: 4 },
  bar: { width: 28, backgroundColor: YELLOW, borderRadius: 4, minHeight: 4 },
  barVal: { color: GREY, fontSize: 10, textAlign: 'center' },
  barLabel: { color: GREY, fontSize: 10, textAlign: 'center' },
  barUnit: { color: GREY, fontSize: 11, textAlign: 'right', marginTop: 4 },

  // Session log list
  logList: { paddingHorizontal: 16, gap: 8 },
  logCard: { backgroundColor: CARD_BG, borderRadius: 12, padding: 14 },
  logRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  logDate: { color: GREY, fontSize: 12, marginBottom: 2 },
  logType: { color: OFF_WHITE, fontSize: 15, fontWeight: '600' },
  logMeta: { alignItems: 'flex-end', gap: 4 },
  logDuration: { color: GREY, fontSize: 13 },
  rpeBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  rpeBadgeText: { fontSize: 12, fontWeight: '700' },

  // Check-in modal
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: CARD_BG, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 24, paddingBottom: 40,
  },
  modalTitle: { color: OFF_WHITE, fontSize: 18, fontWeight: '700', marginBottom: 16, textAlign: 'center' },
  unitRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  unitBtn: {
    flex: 1, backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#262626',
    borderRadius: 10, paddingVertical: 12, alignItems: 'center',
  },
  unitBtnActive: { backgroundColor: YELLOW, borderColor: YELLOW },
  unitBtnText: { color: OFF_WHITE, fontSize: 15, fontWeight: '600' },
  input: {
    backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#262626',
    borderRadius: 10, paddingHorizontal: 16, paddingVertical: 14,
    color: OFF_WHITE, fontSize: 16,
  },
  saveBtn: {
    backgroundColor: YELLOW, borderRadius: 10, paddingVertical: 16,
    alignItems: 'center', marginTop: 14,
  },
  saveBtnText: { color: BLACK, fontSize: 16, fontWeight: '700' },
  cancelText: { color: GREY, fontSize: 15, textAlign: 'center' },
});
