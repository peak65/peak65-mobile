import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '../../lib/supabase';

// ─── Types ───────────────────────────────────────────────────────────────────

type Props = object;

type Checkin = {
  id: string;
  created_at: string;
  weight: number | null;
  weight_unit: string | null;
  body_fat_percentage: number | null;
};

// ─── Colours ──────────────────────────────────────────────────────────────────

const YELLOW    = '#e8ff47';
const BLACK     = '#080808';
const OFF_WHITE = '#f0ede8';
const GREY      = '#8a877f';

// ─── Bar chart ────────────────────────────────────────────────────────────────

const BAR_MAX_HEIGHT = 100;

function BarChart({ values, labels, unit }: { values: number[]; labels: string[]; unit: string }) {
  if (values.length === 0) {
    return (
      <View style={chartStyles.empty}>
        <Text style={chartStyles.emptyText}>No data yet — log a check-in above.</Text>
      </View>
    );
  }

  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;

  return (
    <View style={chartStyles.container}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={chartStyles.barsRow}>
          {values.map((val, i) => {
            const barHeight = ((val - min) / range) * BAR_MAX_HEIGHT + 12;
            return (
              <View key={i} style={chartStyles.barCol}>
                <Text style={chartStyles.barVal}>{val % 1 === 0 ? val : val.toFixed(1)}</Text>
                <View style={[chartStyles.bar, { height: barHeight }]} />
                <Text style={chartStyles.barLabel}>{labels[i]}</Text>
              </View>
            );
          })}
        </View>
      </ScrollView>
      <Text style={chartStyles.unit}>{unit}</Text>
    </View>
  );
}

const chartStyles = StyleSheet.create({
  container: { marginTop: 4 },
  barsRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingBottom: 4,
    minHeight: BAR_MAX_HEIGHT + 56,
  },
  barCol: {
    width: 44,
    alignItems: 'center',
    gap: 4,
  },
  barVal: {
    color: GREY,
    fontSize: 10,
    textAlign: 'center',
  },
  bar: {
    width: 28,
    backgroundColor: YELLOW,
    borderRadius: 4,
    minHeight: 4,
  },
  barLabel: {
    color: GREY,
    fontSize: 10,
    textAlign: 'center',
  },
  unit: {
    color: GREY,
    fontSize: 12,
    textAlign: 'right',
    marginTop: 4,
  },
  empty: {
    paddingVertical: 32,
    alignItems: 'center',
  },
  emptyText: {
    color: GREY,
    fontSize: 14,
  },
});

// ─── Component ───────────────────────────────────────────────────────────────

export default function CheckinScreen(_props: Props) {
  const navigation = { goBack: () => {} };
  const [weightUnit, setWeightUnit]  = useState<'lbs' | 'kg'>('lbs');
  const [weight, setWeight]          = useState('');
  const [bodyFat, setBodyFat]        = useState('');
  const [checkins, setCheckins]      = useState<Checkin[]>([]);
  const [loading, setLoading]        = useState(true);
  const [saving, setSaving]          = useState(false);
  const [activeTab, setActiveTab]    = useState<'weight' | 'bodyfat'>('weight');

  const loadData = useCallback(async () => {
    setLoading(true);
    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) { setLoading(false); return; }

    // Load preferred weight unit from profile
    const { data: profile } = await supabase
      .from('profiles')
      .select('weight_unit')
      .eq('id', authData.user.id)
      .single();
    if (profile?.weight_unit) setWeightUnit(profile.weight_unit as 'lbs' | 'kg');

    // Load up to 20 most recent check-ins
    const { data: history } = await supabase
      .from('checkins')
      .select('*')
      .eq('user_id', authData.user.id)
      .order('created_at', { ascending: true })
      .limit(20);
    if (history) setCheckins(history);

    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  async function handleLog() {
    const w = parseFloat(weight);
    if (isNaN(w) || w <= 0) return;

    setSaving(true);
    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) { setSaving(false); return; }

    const bf = parseFloat(bodyFat);
    await supabase.from('checkins').insert({
      user_id:             authData.user.id,
      weight:              w,
      weight_unit:         weightUnit,
      body_fat_percentage: !isNaN(bf) && bf > 0 ? bf : null,
    });

    setWeight('');
    setBodyFat('');
    setSaving(false);
    await loadData();
  }

  // Derive chart data from history
  const weightPoints = checkins.filter(c => c.weight != null);
  const bfPoints     = checkins.filter(c => c.body_fat_percentage != null);

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });

  const weightValues = weightPoints.map(c => c.weight as number);
  const weightLabels = weightPoints.map(c => fmtDate(c.created_at));
  const bfValues     = bfPoints.map(c => c.body_fat_percentage as number);
  const bfLabels     = bfPoints.map(c => fmtDate(c.created_at));

  const canLog = parseFloat(weight) > 0;

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.headerRow}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Text style={styles.backArrow}>←</Text>
          </TouchableOpacity>
          <Text style={styles.screenTitle}>Check-in</Text>
          <View style={{ width: 32 }} />
        </View>

        {/* ── Log section ──────────────────────────────────────────────────── */}
        <Text style={styles.sectionLabel}>Log today</Text>

        <View style={styles.unitToggleRow}>
          {(['lbs', 'kg'] as const).map(u => (
            <TouchableOpacity
              key={u}
              style={[styles.unitBtn, weightUnit === u && styles.unitBtnSelected]}
              onPress={() => setWeightUnit(u)}
            >
              <Text style={[styles.unitBtnText, weightUnit === u && styles.unitBtnTextSelected]}>
                {u}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <TextInput
          style={styles.input}
          placeholder={`Weight (${weightUnit})`}
          placeholderTextColor={GREY}
          value={weight}
          onChangeText={setWeight}
          keyboardType="decimal-pad"
          selectionColor={YELLOW}
        />

        <TextInput
          style={[styles.input, { marginTop: 10 }]}
          placeholder="Body fat % (optional)"
          placeholderTextColor={GREY}
          value={bodyFat}
          onChangeText={setBodyFat}
          keyboardType="decimal-pad"
          selectionColor={YELLOW}
        />

        <TouchableOpacity
          style={[styles.logBtn, (!canLog || saving) && styles.logBtnDisabled]}
          onPress={handleLog}
          disabled={!canLog || saving}
        >
          <Text style={styles.logBtnText}>{saving ? 'Saving...' : 'Log Check-in'}</Text>
        </TouchableOpacity>

        {/* ── Progress section ──────────────────────────────────────────────── */}
        <Text style={[styles.sectionLabel, { marginTop: 36 }]}>Progress</Text>

        {/* Tab bar */}
        <View style={styles.tabRow}>
          {([
            { key: 'weight',  label: 'Weight' },
            { key: 'bodyfat', label: 'Body Fat %' },
          ] as const).map(tab => (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tab, activeTab === tab.key && styles.tabActive]}
              onPress={() => setActiveTab(tab.key)}
            >
              <Text style={[styles.tabText, activeTab === tab.key && styles.tabTextActive]}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {loading ? (
          <ActivityIndicator color={YELLOW} style={{ marginTop: 32 }} />
        ) : activeTab === 'weight' ? (
          <BarChart values={weightValues} labels={weightLabels} unit={weightUnit} />
        ) : (
          <BarChart values={bfValues} labels={bfLabels} unit="%" />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BLACK,
  },
  content: {
    paddingHorizontal: 24,
    paddingBottom: 40,
  },

  // Header
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
  },
  backArrow: {
    color: OFF_WHITE,
    fontSize: 22,
    width: 32,
  },
  screenTitle: {
    color: OFF_WHITE,
    fontSize: 20,
    fontWeight: '700',
  },

  // Section label
  sectionLabel: {
    color: GREY,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 14,
  },

  // Unit toggle
  unitToggleRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  unitBtn: {
    flex: 1,
    backgroundColor: '#111',
    borderWidth: 1,
    borderColor: '#262626',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  unitBtnSelected: {
    backgroundColor: YELLOW,
    borderColor: YELLOW,
  },
  unitBtnText: {
    color: OFF_WHITE,
    fontSize: 15,
    fontWeight: '600',
  },
  unitBtnTextSelected: {
    color: BLACK,
  },

  // Inputs
  input: {
    backgroundColor: '#111',
    borderWidth: 1,
    borderColor: '#262626',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: OFF_WHITE,
    fontSize: 16,
  },

  // Log button
  logBtn: {
    backgroundColor: YELLOW,
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 14,
  },
  logBtnDisabled: {
    opacity: 0.4,
  },
  logBtnText: {
    color: BLACK,
    fontSize: 16,
    fontWeight: '700',
  },

  // Tabs
  tabRow: {
    flexDirection: 'row',
    backgroundColor: '#111',
    borderRadius: 10,
    padding: 4,
    gap: 4,
    marginBottom: 16,
  },
  tab: {
    flex: 1,
    paddingVertical: 9,
    alignItems: 'center',
    borderRadius: 8,
  },
  tabActive: {
    backgroundColor: YELLOW,
  },
  tabText: {
    color: GREY,
    fontSize: 14,
    fontWeight: '600',
  },
  tabTextActive: {
    color: BLACK,
  },
});
