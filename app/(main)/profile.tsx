import React, { useState, useEffect, useCallback, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, Modal, Platform, Alert, TextInput,
  AppState, KeyboardAvoidingView, InputAccessoryView, Keyboard, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AppleHealthKit, { HealthKitPermissions } from 'react-native-health';
import { supabase } from '../../lib/supabase';
import { fetchTodayHealthData, fetchTodayWorkouts, type WearableHealthData } from '../../lib/healthKit';
import { computeTDEEFromProfile, type TDEEResult } from '../../lib/tdee';
import { calculatePeakScore } from '../../lib/peakScore';
import { getConnectedWearables, resolveAllSources } from '../../lib/wearablePriority';
import { getWhoopAuthUrl } from '../../lib/whoopApi';
import { clearUserCache } from '../../lib/userCache';
import SliderInput from '../../components/SliderInput';
import { Colors, Fonts } from '../../lib/theme';
import { Feather } from '@expo/vector-icons';

// ─── Types ────────────────────────────────────────────────────────────────────

type Profile = {
  id: string;
  first_name: string;
  last_name: string;
  email?: string;
  goal: string;
  hyrox_division: string | null;
  rest_days: number | null;
  session_length: string | null;
  availability: string | null;
  equipment_access: string[] | string | null;
  station_weaknesses: string[] | string | null;
  body_weight: number | null;
  weight_unit: string | null;
  body_fat_range: string | null;
  wearable_connected: boolean | null;
  wearable_type: string | null;
  // TDEE inputs
  age: number | null;
  gender: string | null;              // 'male' | 'female'
  height_cm: number | null;          // stored as cm
  weight_kg: number | null;          // stored as kg
  preferred_units: string | null;    // 'imperial' | 'metric'
  current_training_days: string | null;
  // Legacy onboarding fields (web app path) — kept as fallback
  height: string | null;
  weight: string | null;
  units: string | null;
  // Manual HRV (Zepp / non-Apple-Health wearables)
  manual_hrv: number | null;
  manual_hrv_date: string | null;
  // Wearable direct connections
  whoop_connected?: boolean | null;
  whoop_access_token?: string | null;
  whoop_refresh_token?: string | null;
  garmin_connected?: boolean | null;
  coros_connected?: boolean | null;
  // Goal switching
  previous_goal?: string | null;
  goal_switched_at?: string | null;
  coached_upsell_dismissed?: boolean | null;
  race_date?: string | null;
  goal_time?: string | null;
  run_confidence?: number | null;
  primary_goal?: string | null;
  date_of_birth?: string | null;
  // Coaching tier — 'elite' (Pinnacle) athletes have a coach who owns their
  // programming, so this screen hides every control that would alter it.
  tier?: string | null;
};

// Postgres text[] can arrive as a JS array, a "{a,b}" string, or null.
function toStringArray(val: string[] | string | null | undefined): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  const match = val.match(/^\{(.*)\}$/s);
  if (match) {
    if (!match[1].length) return [];
    return match[1].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
  }
  return [];
}

// ─── Unit formatting ──────────────────────────────────────────────────────────

function formatHeightDisplay(heightCm: number, imperial: boolean): string {
  if (!imperial) return `${Math.round(heightCm)} cm`;
  const totalInches = Math.round(heightCm / 2.54);
  return `${Math.floor(totalInches / 12)}' ${totalInches % 12}"`;
}

function formatWeightDisplay(weightKg: number, imperial: boolean): string {
  if (!imperial) return `${Math.round(weightKg)} kg`;
  return `${Math.round(weightKg / 0.453592)} lb`;
}

// ─── Slider modal — for editing height / weight ───────────────────────────────

function SliderModal({
  title,
  value,
  min,
  max,
  displayValue,
  onConfirm,
  onClose,
}: {
  title: string;
  value: number;
  min: number;
  max: number;
  displayValue: (v: number) => string;
  onConfirm: (v: number) => void;
  onClose: () => void;
}) {
  const [local, setLocal] = React.useState(value);
  return (
    <Modal transparent animationType="slide" visible>
      <View style={styles.pickerBackdrop}>
        <View style={[styles.pickerSheet, { paddingBottom: 40 }]}>
          <Text style={styles.pickerTitle}>{title}</Text>
          <Text style={sliderModalStyles.valueText}>{displayValue(local)}</Text>
          <View style={{ marginVertical: 16 }}>
            <SliderInput value={local} min={min} max={max} onChange={setLocal} />
            <View style={sliderModalStyles.rangeRow}>
              <Text style={sliderModalStyles.rangeText}>{displayValue(min)}</Text>
              <Text style={sliderModalStyles.rangeText}>{displayValue(max)}</Text>
            </View>
          </View>
          <TouchableOpacity style={styles.saveBtn} onPress={() => { onConfirm(local); onClose(); }}>
            <Text style={styles.saveBtnText}>SAVE</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onClose} style={{ marginTop: 8 }}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const sliderModalStyles = StyleSheet.create({
  valueText: {
    color: Colors.textPrimary, fontFamily: Fonts.metricHeavy, fontSize: 44,
    textAlign: 'center', letterSpacing: -1, marginBottom: 4,
  },
  rangeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  rangeText: { color: Colors.textSecondary, fontSize: 12 },
});

// ─── TDEE computation (delegated to lib/tdee.ts) ─────────────────────────────

// ─── Picker modal ─────────────────────────────────────────────────────────────

function PickerModal({
  title, options, value, onSelect, onClose,
}: {
  title: string;
  options: { label: string; value: string }[];
  value: string | null;
  onSelect: (v: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal transparent animationType="slide" visible>
      <View style={styles.pickerBackdrop}>
        <View style={styles.pickerSheet}>
          <Text style={styles.pickerTitle}>{title}</Text>
          {options.map(opt => (
            <TouchableOpacity key={opt.value}
              style={[styles.pickerOption, value === opt.value && styles.pickerOptionActive]}
              onPress={() => { onSelect(opt.value); onClose(); }}>
              <Text style={[styles.pickerOptionText, value === opt.value && { color: Colors.background }]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity onPress={onClose} style={{ marginTop: 8 }}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ─── Multi-select modal ───────────────────────────────────────────────────────

function MultiSelectModal({
  title, options, values, onSave, onClose,
}: {
  title: string;
  options: string[];
  values: string[];
  onSave: (vs: string[]) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(values);
  function toggle(v: string) {
    setSelected(s => s.includes(v) ? s.filter(x => x !== v) : [...s, v]);
  }
  return (
    <Modal transparent animationType="slide" visible>
      <View style={styles.pickerBackdrop}>
        <View style={[styles.pickerSheet, { maxHeight: '75%' }]}>
          <Text style={styles.pickerTitle}>{title}</Text>
          <ScrollView showsVerticalScrollIndicator={false}>
            {options.map(opt => (
              <TouchableOpacity key={opt}
                style={[styles.pickerOption, selected.includes(opt) && styles.pickerOptionActive]}
                onPress={() => toggle(opt)}>
                <Text style={[styles.pickerOptionText, selected.includes(opt) && { color: Colors.background }]}>
                  {opt}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <TouchableOpacity style={styles.saveBtn}
            onPress={() => { onSave(selected); onClose(); }}>
            <Text style={styles.saveBtnText}>SAVE</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onClose} style={{ marginTop: 8 }}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ─── Weakness + goal options ──────────────────────────────────────────────────

const REGEN_TRIGGER_FIELDS = new Set(['rest_days', 'session_length', 'availability', 'equipment_access']);

const WEAKNESS_OPTIONS = [
  'SkiErg', 'Sled Push', 'Sled Pull', 'Burpee Broad Jump',
  'Rowing', 'Farmers Carry', 'Sandbag Lunges', 'Wall Balls', 'Running',
];

const GF_PRIMARY_GOALS = [
  { label: 'Fat Loss',          value: 'fat_loss' },
  { label: 'Build Muscle',      value: 'build_muscle' },
  { label: 'Improve Endurance', value: 'endurance' },
  { label: 'Overall Fitness',   value: 'overall' },
];

// ─── Health reading row ───────────────────────────────────────────────────────

function HealthReadingRow({
  label,
  reading,
  unit,
  formatValue,
  onSourcePress,
  confidence,
}: {
  label: string;
  reading: { value: number; source: string } | null;
  unit?: string;
  formatValue?: (v: number) => string;
  onSourcePress?: () => void;
  confidence?: 'high' | 'medium' | null;
}) {
  const display = reading
    ? `${formatValue ? formatValue(reading.value) : reading.value}${unit ?? ''}`
    : '--';
  return (
    <View style={styles.healthRow}>
      <Text style={styles.settingLabel}>{label}</Text>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[styles.settingValue, reading && { color: Colors.textPrimary }]}>{display}</Text>
        {reading && onSourcePress ? (
          <TouchableOpacity onPress={onSourcePress} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
            <Text style={styles.healthSource}>{confidence === 'medium' ? '⚠️ ' : ''}{reading.source} ⓘ</Text>
          </TouchableOpacity>
        ) : reading ? (
          <Text style={styles.healthSource}>{confidence === 'medium' ? '⚠️ ' : ''}{reading.source}</Text>
        ) : null}
      </View>
    </View>
  );
}

// ─── Row components ───────────────────────────────────────────────────────────

function SettingRow({
  label, value, onPress,
}: {
  label: string; value: string; onPress?: () => void;
}) {
  return (
    <TouchableOpacity style={styles.settingRow} onPress={onPress} disabled={!onPress}>
      <Text style={styles.settingLabel}>{label}</Text>
      <View style={styles.settingRight}>
        <Text style={styles.settingValue} numberOfLines={1}>{value || '—'}</Text>
        {!!onPress && <Feather name="chevron-right" color={Colors.textSecondary} size={16} />}
      </View>
    </TouchableOpacity>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ProfileScreen() {
  const navigation = useNavigation();
  const [profile, setProfile]             = useState<Profile | null>(null);
  const [email, setEmail]                 = useState('');
  const [loading, setLoading]             = useState(true);
  const [picker, setPicker]               = useState<string | null>(null);
  const [healthConnecting, setHealthConnecting] = useState(false);
  const [healthData, setHealthData]       = useState<WearableHealthData | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [tdeeMissingFields, setTdeeMissingFields] = useState<string[]>([]);
  const [metricsPicker, setMetricsPicker] = useState<'gender' | 'units' | 'height' | 'weight' | 'dob' | null>(null);
  const [dobPickerDate, setDobPickerDate] = useState<Date>(new Date());
  const [manualHRVOpen, setManualHRVOpen]   = useState(false);
  const [manualHRVInput, setManualHRVInput] = useState('');
  const [manualHRVError, setManualHRVError] = useState('');

  // Goal switching
  const [goalSwitchOpen, setGoalSwitchOpen]     = useState(false);
  const [goalSwitchStep, setGoalSwitchStep]     = useState<'confirm'|'collect'|'generating'|'done'>('confirm');
  const [targetGoal, setTargetGoal]             = useState('');
  const [gsRaceDate, setGsRaceDate]             = useState('');
  const [gsDivision, setGsDivision]             = useState('');
  const [gsGoalTime, setGsGoalTime]             = useState('');
  const [gsWeaknesses, setGsWeaknesses]         = useState<string[]>([]);
  const [gsRunConfidence, setGsRunConfidence]   = useState(3);
  const [gsPrimaryGoal, setGsPrimaryGoal]       = useState('');
  const [showCoachedUpsell, setShowCoachedUpsell] = useState(false);
  const [whoopConnecting, setWhoopConnecting]     = useState(false);
  const [programRegenStatus, setProgramRegenStatus] = useState<'idle' | 'regenerating' | 'done'>('idle');

  const mounted      = useRef(true);
  const loadIdRef    = useRef(0);
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // profileOverride: pass freshly-loaded data from `load` before setProfile resolves.
  async function loadHealthData(userId: string, profileOverride?: Profile | null) {
    const profileData = profileOverride ?? profile;
    console.log('[profile] loadHealthData called, userId:', userId);
    setHealthLoading(true);
    try {
      console.log('[profile] calling fetchTodayHealthData');
      // Whoop data is fetched and written to daily_health_readings by the backend
      // cron now — mobile only reads HealthKit here and reads the table for display.
      const data = await fetchTodayHealthData();
      console.log('[profile] got health data:', JSON.stringify(data));

      // Calculate TDEE from profile and override basal/total calories
      if (profileData) {
        const tdee = computeTDEEFromProfile(profileData);
        if (tdee.ok) {
          setTdeeMissingFields([]);
          const tdeeBase = tdee.value;
          const activeVal = data.activeCalories?.value ?? 0;
          const activeSource = data.activeCalories?.source;
          data.basalCalories = { value: tdeeBase, source: 'Calculated' };
          if (activeSource === 'Whoop') {
            console.log('[whoop] strain kcal:', activeVal, 'tdee base:', tdeeBase, 'total:', tdeeBase + activeVal);
          }
          data.totalCalories = {
            value: tdeeBase + activeVal,
            source: activeSource ? `${activeSource} + Calculated` : 'Calculated',
          };
          console.log('[profile] TDEE base:', tdeeBase, 'total:', data.totalCalories.value);
        } else {
          setTdeeMissingFields(tdee.missing);
          data.basalCalories = null;
          data.totalCalories = null;
        }
      }

      if (!mounted.current) return;
      setHealthData(data);
      const today = new Date().toLocaleDateString('en-CA');

      // Override HRV with manual entry if logged today (for Zepp/non-HK wearables)
      const manualHrvToday = (profileData?.manual_hrv_date === today && profileData?.manual_hrv != null)
        ? profileData.manual_hrv : null;
      if (manualHrvToday != null && data.hrv == null) {
        data.hrv = { value: manualHrvToday, source: 'Zepp (manual)' };
      }

      // Compute and store Peak Score
      await calculatePeakScore(userId, {
        hrv: data.hrv?.value ?? null,
        rhr: data.restingHR?.value ?? null,
        sleepHours: data.sleepHours?.value ?? null,
        activeCalories: data.activeCalories?.value ?? null,
      });

      // Sync external workouts from HealthKit
      const workouts = await fetchTodayWorkouts(userId);
      if (workouts.length > 0) {
        await supabase.from('external_workouts').upsert(
          workouts.map(w => ({
            user_id: userId,
            external_id: w.externalId,
            workout_type: w.type,
            start_time: w.startDate,
            end_time: w.endDate,
            duration_minutes: w.durationMinutes,
            distance_km: w.distanceKm,
            calories: w.calories,
            source: w.source,
            avg_hr: w.avgHr,
            max_hr: w.maxHr,
            pace_per_km: w.pacePerKm,
            effort_zone: w.effortZone,
          })),
          { onConflict: 'user_id,external_id' },
        );
      }
    } catch (err) {
      console.log('[profile] health load error:', err);
    } finally {
      setHealthLoading(false);
    }
  }

  async function executeGoalSwitch() {
    if (!profile) return;
    // Pinnacle athletes' programs are hand-built by their coach. Save the goal
    // change, but never archive or rebuild the program. The control that opens
    // this modal is hidden for elite — this is the backstop.
    const skipRegen = profile.tier === 'elite';
    setGoalSwitchStep('generating');
    try {
      if (!skipRegen) {
        await supabase.from('programs').update({ status: 'archived' }).eq('user_id', profile.id);
      }
      const patch: Partial<Profile> = {
        goal: targetGoal,
        previous_goal: profile.goal,
        goal_switched_at: new Date().toISOString(),
      };
      if (targetGoal === 'hyrox') {
        if (gsDivision) patch.hyrox_division = gsDivision;
        if (gsRaceDate) patch.race_date = gsRaceDate;
        if (gsGoalTime) patch.goal_time = gsGoalTime;
        if (gsWeaknesses.length) patch.station_weaknesses = gsWeaknesses;
        patch.run_confidence = gsRunConfidence;
      } else {
        if (gsPrimaryGoal) patch.primary_goal = gsPrimaryGoal;
      }
      await updateProfile(patch);
      if (!skipRegen) {
        const res = await fetch('https://peak65.vercel.app/api/generate-assessment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: profile.id }),
        });
        if (!res.ok) throw new Error('generate-assessment returned ' + res.status);
      }
      setGoalSwitchStep('done');
    } catch (e) {
      console.log('[goalSwitch] error:', e);
      setGoalSwitchStep('collect');
      Alert.alert('Error', 'Something went wrong generating your program. Please try again.');
    }
  }

  const load = useCallback(async () => {
    const myId = ++loadIdRef.current;
    setLoading(true);
    const { data: { session } } = await supabase.auth.getSession();
    if (!mounted.current || myId !== loadIdRef.current) { setLoading(false); return; }
    if (!session?.user) { setLoading(false); return; }
    setEmail(session.user.email ?? '');

    const { data } = await supabase.from('profiles').select('*').eq('id', session.user.id).single();
    if (!mounted.current || myId !== loadIdRef.current) { setLoading(false); return; }

    setProfile(data);
    setLoading(false);

    const appleHealthConnected = !!(data?.wearable_connected && data?.wearable_type === 'apple_health');
    const whoopConnected = !!data?.whoop_connected;
    console.log('[profile] mount, appleHealthConnected:', appleHealthConnected, 'whoopConnected:', whoopConnected);
    console.log('[whoop] has refresh token:', !!data?.whoop_refresh_token);
    if (appleHealthConnected || whoopConnected) {
      loadHealthData(session.user.id, data);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFocusEffect(useCallback(() => {
    console.log('[health] auto-refresh triggered by: focus');
    load();
  }, [load]));

  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', next => {
      if (next === 'active') {
        console.log('[health] auto-refresh triggered by: foreground');
        if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
        loadTimerRef.current = setTimeout(() => {
          loadTimerRef.current = null;
          loadRef.current();
        }, 500);
      }
    });
    return () => {
      sub.remove();
      if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    };
  }, []);

  async function updateProfile(patch: Partial<Profile>) {
    if (!profile) return;
    const updated = { ...profile, ...patch };
    setProfile(updated);
    await supabase.from('profiles').update(patch).eq('id', profile.id);

    // Pinnacle athletes' programs belong to their coach — the benign field value
    // above is still saved, but nothing here may archive or rebuild a program.
    // The rows that write these fields are hidden for elite; this is the backstop.
    if (profile.tier !== 'elite' && Object.keys(patch).some(k => REGEN_TRIGGER_FIELDS.has(k))) {
      setProgramRegenStatus('regenerating');
      try {
        await supabase.from('programs').update({ status: 'archived' }).eq('user_id', profile.id);
        await fetch('https://peak65.vercel.app/api/generate-assessment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: profile.id }),
        });
        setProgramRegenStatus('done');
        setTimeout(() => setProgramRegenStatus('idle'), 3000);
      } catch (e) {
        console.log('[profile] regen error:', e);
        setProgramRegenStatus('idle');
      }
    }
  }

  async function handleSignOut() {
    // Cleared before signOut so nothing can re-read this athlete's cached
    // program between the two calls. The next account starts from an empty cache.
    await clearUserCache();
    await supabase.auth.signOut();
  }

  function connectAppleHealth() {
    if (!profile || Platform.OS !== 'ios') return;
    setHealthConnecting(true);

    const permissions: HealthKitPermissions = {
      permissions: {
        read: [
          AppleHealthKit.Constants.Permissions.HeartRateVariability,
          AppleHealthKit.Constants.Permissions.RestingHeartRate,
          AppleHealthKit.Constants.Permissions.SleepAnalysis,
          AppleHealthKit.Constants.Permissions.Steps,
          AppleHealthKit.Constants.Permissions.ActiveEnergyBurned,
          AppleHealthKit.Constants.Permissions.BasalEnergyBurned,
          AppleHealthKit.Constants.Permissions.HeartRate,
          AppleHealthKit.Constants.Permissions.Workout,
        ],
        write: [],
      },
    };

    AppleHealthKit.initHealthKit(permissions, (error: string) => {
      console.log('[healthkit] initHealthKit error:', error);
      if (error) {
        console.log('[healthkit] initHealthKit failed:', error);
        Alert.alert('Apple Health', 'Could not connect: ' + error);
        setHealthConnecting(false);
        return;
      }
      console.log('[healthkit] initHealthKit success — permissions granted');
      updateProfile({ wearable_connected: true, wearable_type: 'apple_health' });
      setHealthConnecting(false);
      loadHealthData(profile.id);
    });
  }

  async function connectWhoop() {
    setWhoopConnecting(true);
    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user?.id;
    if (!userId) {
      Alert.alert('Error', 'Could not start Whoop connection. Please sign in again.');
      setWhoopConnecting(false);
      return;
    }
    // state carries the userId; the backend redirect (getpeak65.com/api/whoop/connect)
    // performs the code exchange and stores tokens server-side.
    const url = getWhoopAuthUrl(userId);
    Linking.openURL(url).catch(e => {
      console.log('[whoop] openURL error:', e);
      Alert.alert('Error', 'Could not open Whoop authorization page.');
      setWhoopConnecting(false);
    });
  }

  function disconnectWhoop() {
    if (!profile?.id) return;
    Alert.alert(
      'Disconnect Whoop',
      'This will remove your Whoop connection. You can reconnect at any time.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            await supabase.from('profiles').update({
              whoop_connected:     false,
              whoop_access_token:  null,
              whoop_refresh_token: null,
              whoop_token_expiry:  null,
            }).eq('id', profile!.id);
            setProfile(prev => prev
              ? { ...prev, whoop_connected: false, whoop_access_token: null, whoop_refresh_token: null }
              : prev,
            );
            console.log('[whoop] disconnected — tokens cleared from Supabase');
          },
        },
      ],
    );
  }

  // Deep link handler — the backend redirects to
  // peak65://auth/whoop/callback?status=success|error after it has exchanged the
  // code and stored tokens server-side. Mobile just refreshes its connected state.
  useEffect(() => {
    const handleUrl = async ({ url }: { url: string }) => {
      if (!url.startsWith('peak65://auth/whoop/callback')) return;
      console.log('[whoop] deep link received:', url);
      const queryIdx = url.indexOf('?');
      const status = queryIdx !== -1
        ? new URLSearchParams(url.slice(queryIdx + 1)).get('status')
        : null;

      if (status === 'success') {
        setWhoopConnecting(true);
        try {
          await load(); // re-read profile so whoop_connected flips to true in the UI
        } finally {
          setWhoopConnecting(false);
        }
        Alert.alert('Whoop Connected', 'Your Whoop data will sync automatically.');
      } else {
        Alert.alert('Error', 'Could not connect Whoop. Please try again.');
      }
    };

    const sub = Linking.addEventListener('url', handleUrl);
    Linking.getInitialURL().then(url => { if (url) handleUrl({ url }); });
    return () => sub.remove();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <ActivityIndicator color={Colors.accent} style={{ flex: 1 }} />
      </SafeAreaView>
    );
  }

  // Pinnacle athletes: their coach owns programming, so every control that
  // would change it is withheld from this screen.
  const isElite = profile?.tier === 'elite';

  const goalBadge = profile?.goal === 'hyrox'
    ? `Hyrox${profile.hyrox_division ? ` • ${profile.hyrox_division}` : ''}`
    : profile?.goal === 'general_fitness' ? 'General Fitness' : '';

  const wearableReadings = (healthData && profile) ? (() => {
    const wearables = getConnectedWearables(profile as any);
    const tdee = computeTDEEFromProfile(profile);
    const base = tdee.ok ? tdee.value : null;
    return resolveAllSources(wearables, healthData as any, profile as any, base);
  })() : null;

  const GOAL_OPTIONS = [
    { label: 'Train for Hyrox', value: 'hyrox' },
    { label: 'General Fitness', value: 'general_fitness' },
  ];
  const DIVISION_OPTIONS = [
    { label: 'Men Open', value: 'Men Open' },
    { label: 'Men Pro', value: 'Men Pro' },
    { label: 'Women Open', value: 'Women Open' },
    { label: 'Women Pro', value: 'Women Pro' },
    { label: 'Mixed Doubles', value: 'Mixed Doubles' },
  ];
  const REST_OPTIONS = [
    { label: '1 day', value: '1' },
    { label: '2 days', value: '2' },
    { label: '3 days', value: '3' },
  ];
  const LENGTH_OPTIONS = [
    { label: 'About 1 hour', value: '60' },
    { label: 'About 1.5–2 hours', value: '90' },
  ];
  const AVAIL_OPTIONS = [
    { label: 'Once a day', value: 'once' },
    { label: 'Twice a day (AM + PM)', value: 'both' },
  ];
  const EQUIPMENT_OPTIONS = profile?.goal === 'hyrox'
    ? ['Barbell + Rack', 'Dumbbells', 'Kettlebells', 'Pull-up Bar', 'Ski Erg', 'Row Erg', 'Sled', 'Assault Bike', 'Full Gym Access']
    : ['Barbell + Rack', 'Dumbbells', 'Kettlebells', 'Pull-up Bar', 'Ski Erg', 'Row Erg', 'Assault Bike', 'Full Gym Access', 'No Equipment'];
  const BF_OPTIONS = [
    { label: 'Under 10%', value: 'Under 10%' },
    { label: '10–15%', value: '10-15%' },
    { label: '15–20%', value: '15-20%' },
    { label: '20–25%', value: '20-25%' },
    { label: '25–30%', value: '25-30%' },
    { label: '30%+', value: '30%+' },
    { label: "Unsure", value: 'unsure' },
  ];

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Pickers */}
      {picker === 'division' && (
        <PickerModal title="Division" options={DIVISION_OPTIONS} value={profile?.hyrox_division ?? null}
          onSelect={v => updateProfile({ hyrox_division: v })} onClose={() => setPicker(null)} />
      )}
      {picker === 'rest' && (
        <PickerModal title="Rest Days" options={REST_OPTIONS} value={String(profile?.rest_days ?? '')}
          onSelect={v => updateProfile({ rest_days: parseInt(v, 10) })} onClose={() => setPicker(null)} />
      )}
      {picker === 'length' && (
        <PickerModal title="Session Length" options={LENGTH_OPTIONS} value={profile?.session_length ?? null}
          onSelect={v => updateProfile({ session_length: v })} onClose={() => setPicker(null)} />
      )}
      {picker === 'availability' && (
        <PickerModal title="Availability" options={AVAIL_OPTIONS} value={profile?.availability ?? null}
          onSelect={v => updateProfile({ availability: v })} onClose={() => setPicker(null)} />
      )}
      {picker === 'bf' && (
        <PickerModal title="Body Fat Range" options={BF_OPTIONS} value={profile?.body_fat_range ?? null}
          onSelect={v => updateProfile({ body_fat_range: v })} onClose={() => setPicker(null)} />
      )}
      {picker === 'equipment' && (
        <MultiSelectModal
          title="Equipment Access"
          options={EQUIPMENT_OPTIONS}
          values={toStringArray(profile?.equipment_access)}
          onSave={vs => updateProfile({ equipment_access: vs })}
          onClose={() => setPicker(null)}
        />
      )}

      {/* Body metrics modals */}
      {metricsPicker === 'gender' && (
        <PickerModal
          title="Gender"
          options={[{ label: 'Male', value: 'male' }, { label: 'Female', value: 'female' }]}
          value={profile?.gender ?? null}
          onSelect={v => updateProfile({ gender: v })}
          onClose={() => setMetricsPicker(null)}
        />
      )}
      {metricsPicker === 'units' && (
        <PickerModal
          title="Units"
          options={[{ label: 'Imperial (lb, ft/in)', value: 'imperial' }, { label: 'Metric (kg, cm)', value: 'metric' }]}
          value={profile?.preferred_units ?? null}
          onSelect={v => updateProfile({ preferred_units: v })}
          onClose={() => setMetricsPicker(null)}
        />
      )}
      {metricsPicker === 'height' && (() => {
        const imp = (profile?.preferred_units ?? 'imperial') === 'imperial';
        const currentCm = profile?.height_cm ?? (imp ? 68 * 2.54 : 170);
        const displayVal = imp ? Math.round(currentCm / 2.54) : Math.round(currentCm);
        return (
          <SliderModal
            title="Height"
            value={displayVal}
            min={imp ? 54 : 137}
            max={imp ? 84 : 213}
            displayValue={v => formatHeightDisplay(imp ? v * 2.54 : v, imp)}
            onConfirm={v => updateProfile({ height_cm: imp ? Math.round(v * 2.54) : v })}
            onClose={() => setMetricsPicker(null)}
          />
        );
      })()}
      {metricsPicker === 'weight' && (() => {
        const imp = (profile?.preferred_units ?? 'imperial') === 'imperial';
        const currentKg = profile?.weight_kg ?? (imp ? 165 * 0.453592 : 75);
        const displayVal = imp ? Math.round(currentKg / 0.453592) : Math.round(currentKg);
        return (
          <SliderModal
            title="Weight"
            value={displayVal}
            min={imp ? 80 : 36}
            max={imp ? 350 : 159}
            displayValue={v => formatWeightDisplay(imp ? v * 0.453592 : v, imp)}
            onConfirm={v => updateProfile({ weight_kg: imp ? Math.round(v * 0.453592 * 10) / 10 : v })}
            onClose={() => setMetricsPicker(null)}
          />
        );
      })()}

      {metricsPicker === 'dob' && (() => {
        const maxDob = new Date();
        maxDob.setFullYear(maxDob.getFullYear() - 13);
        const minDob = new Date();
        minDob.setFullYear(minDob.getFullYear() - 99);
        return (
          <Modal transparent animationType="slide" visible>
            <View style={styles.pickerBackdrop}>
              <View style={[styles.pickerSheet, { paddingBottom: 40 }]}>
                <Text style={styles.pickerTitle}>Date of Birth</Text>
                <DateTimePicker
                  value={dobPickerDate}
                  mode="date"
                  display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                  themeVariant="dark"
                  maximumDate={maxDob}
                  minimumDate={minDob}
                  onChange={(_event, date) => {
                    if (date) setDobPickerDate(date);
                  }}
                  style={{ width: '100%' }}
                />
                <TouchableOpacity
                  style={styles.saveBtn}
                  onPress={() => {
                    const dobStr = dobPickerDate.toISOString().split('T')[0];
                    const age = Math.floor((Date.now() - dobPickerDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
                    updateProfile({ date_of_birth: dobStr, age });
                    setMetricsPicker(null);
                  }}
                >
                  <Text style={styles.saveBtnText}>SAVE</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setMetricsPicker(null)} style={{ marginTop: 12, alignItems: 'center' }}>
                  <Text style={{ color: Colors.textSecondary, fontSize: 13 }}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </View>
          </Modal>
        );
      })()}

      {/* Goal switching modal */}
      <Modal
        visible={goalSwitchOpen}
        transparent
        animationType="slide"
        onRequestClose={() => goalSwitchStep !== 'generating' && setGoalSwitchOpen(false)}
      >
        <View style={styles.pickerBackdrop}>
          <View style={[styles.pickerSheet, { maxHeight: '90%', paddingBottom: 40 }]}>
            {goalSwitchStep === 'confirm' && (
              <>
                <Text style={styles.pickerTitle}>Switch Goal?</Text>
                <View style={styles.gsGoalRow}>
                  <View style={styles.gsGoalChip}>
                    <Text style={styles.gsGoalChipText}>
                      {profile?.goal === 'hyrox' ? 'Hyrox' : 'General Fitness'}
                    </Text>
                  </View>
                  <Text style={styles.gsArrow}>→</Text>
                  <View style={[styles.gsGoalChip, styles.gsGoalChipNew]}>
                    <Text style={[styles.gsGoalChipText, { color: Colors.background }]}>
                      {targetGoal === 'hyrox' ? 'Hyrox' : 'General Fitness'}
                    </Text>
                  </View>
                </View>
                <Text style={styles.gsSub}>
                  This will archive your current program and generate a new one tailored to your new goal.
                </Text>
                <TouchableOpacity style={styles.saveBtn} onPress={() => setGoalSwitchStep('collect')}>
                  <Text style={styles.saveBtnText}>CONTINUE</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setGoalSwitchOpen(false)} style={{ marginTop: 8, alignItems: 'center' }}>
                  <Text style={styles.cancelText}>Cancel</Text>
                </TouchableOpacity>
              </>
            )}

            {goalSwitchStep === 'collect' && targetGoal === 'hyrox' && (
              <ScrollView showsVerticalScrollIndicator={false}>
                <Text style={styles.pickerTitle}>Tell Us About Your Race</Text>
                <Text style={styles.gsFieldLabel}>Division</Text>
                {DIVISION_OPTIONS.map(d => (
                  <TouchableOpacity key={d.value}
                    style={[styles.pickerOption, gsDivision === d.value && styles.pickerOptionActive]}
                    onPress={() => setGsDivision(d.value)}>
                    <Text style={[styles.pickerOptionText, gsDivision === d.value && { color: Colors.background }]}>{d.label}</Text>
                  </TouchableOpacity>
                ))}
                <Text style={styles.gsFieldLabel}>Race Date (optional)</Text>
                <TextInput
                  style={styles.gsTextInput}
                  value={gsRaceDate}
                  onChangeText={setGsRaceDate}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={Colors.textSecondary}
                  selectionColor={Colors.accent}
                />
                <Text style={styles.gsFieldLabel}>Goal Time (optional)</Text>
                <TextInput
                  style={styles.gsTextInput}
                  value={gsGoalTime}
                  onChangeText={setGsGoalTime}
                  placeholder="e.g. 1:30:00"
                  placeholderTextColor={Colors.textSecondary}
                  selectionColor={Colors.accent}
                />
                <Text style={styles.gsFieldLabel}>Run Confidence</Text>
                <Text style={styles.gsSub}>1 = needs the most work, 5 = your strongest asset</Text>
                <View style={styles.gsConfidenceRow}>
                  {[1,2,3,4,5].map(n => (
                    <TouchableOpacity key={n}
                      style={[styles.gsConfidenceBtn, gsRunConfidence === n && styles.gsConfidenceBtnActive]}
                      onPress={() => setGsRunConfidence(n)}>
                      <Text style={[styles.gsConfidenceBtnText, gsRunConfidence === n && { color: Colors.background }]}>{n}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.gsFieldLabel}>Station Weaknesses</Text>
                {WEAKNESS_OPTIONS.map(w => (
                  <TouchableOpacity key={w}
                    style={[styles.pickerOption, gsWeaknesses.includes(w) && styles.pickerOptionActive]}
                    onPress={() => setGsWeaknesses(p => p.includes(w) ? p.filter(x => x !== w) : [...p, w])}>
                    <Text style={[styles.pickerOptionText, gsWeaknesses.includes(w) && { color: Colors.background }]}>{w}</Text>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity style={[styles.saveBtn, { marginTop: 16, marginBottom: 8 }]} onPress={executeGoalSwitch}>
                  <Text style={styles.saveBtnText}>GENERATE MY PROGRAM</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setGoalSwitchStep('confirm')} style={{ alignItems: 'center', paddingBottom: 8 }}>
                  <Text style={styles.cancelText}>Back</Text>
                </TouchableOpacity>
              </ScrollView>
            )}

            {goalSwitchStep === 'collect' && targetGoal === 'general_fitness' && (
              <>
                <Text style={styles.pickerTitle}>What's Your Primary Goal?</Text>
                {GF_PRIMARY_GOALS.map(g => (
                  <TouchableOpacity key={g.value}
                    style={[styles.pickerOption, gsPrimaryGoal === g.value && styles.pickerOptionActive]}
                    onPress={() => setGsPrimaryGoal(g.value)}>
                    <Text style={[styles.pickerOptionText, gsPrimaryGoal === g.value && { color: Colors.background }]}>{g.label}</Text>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity
                  style={[styles.saveBtn, { marginTop: 16, opacity: gsPrimaryGoal ? 1 : 0.5 }]}
                  onPress={executeGoalSwitch}
                  disabled={!gsPrimaryGoal}
                >
                  <Text style={styles.saveBtnText}>GENERATE MY PROGRAM</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setGoalSwitchStep('confirm')} style={{ marginTop: 8, alignItems: 'center' }}>
                  <Text style={styles.cancelText}>Back</Text>
                </TouchableOpacity>
              </>
            )}

            {goalSwitchStep === 'generating' && (
              <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                <ActivityIndicator color={Colors.accent} size="large" />
                <Text style={[styles.pickerTitle, { marginTop: 20 }]}>Building Your Program...</Text>
                <Text style={styles.gsSub}>
                  Your coach is reviewing your profile and generating a personalised plan.
                </Text>
              </View>
            )}

            {goalSwitchStep === 'done' && (
              <View style={{ alignItems: 'center', paddingVertical: 20 }}>
                <Text style={{ fontSize: 52, marginBottom: 12 }}>✅</Text>
                <Text style={styles.pickerTitle}>Program Ready!</Text>
                <Text style={styles.gsSub}>
                  Your new {targetGoal === 'hyrox' ? 'Hyrox' : 'General Fitness'} program has been generated.
                  Head to the Program tab to view it.
                </Text>
                <TouchableOpacity
                  style={[styles.saveBtn, { marginTop: 20, width: '100%' }]}
                  onPress={() => {
                    setGoalSwitchOpen(false);
                    if (profile?.coached_upsell_dismissed !== true) setShowCoachedUpsell(true);
                  }}
                >
                  <Text style={styles.saveBtnText}>DONE</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>
      </Modal>

      {/* Manual HRV entry modal */}
      <Modal visible={manualHRVOpen} transparent animationType="slide" onRequestClose={() => setManualHRVOpen(false)}>
        <KeyboardAvoidingView behavior="padding" style={{ flex: 1, justifyContent: 'flex-end' }}>
          <View style={styles.manualHRVCard}>
            <ScrollView keyboardShouldPersistTaps="handled" bounces={false}>
              <Text style={styles.manualHRVTitle}>Log Morning HRV</Text>
              <Text style={styles.manualHRVSub}>
                Open your Zepp app → Readiness tab → HRV, then enter your morning reading below.
              </Text>
              <TextInput
                style={styles.manualHRVInput}
                placeholder="e.g. 52"
                placeholderTextColor={Colors.textSecondary}
                value={manualHRVInput}
                onChangeText={v => { setManualHRVInput(v); setManualHRVError(''); }}
                keyboardType="number-pad"
                inputAccessoryViewID="hrv-input-accessory"
                selectionColor={Colors.accent}
                maxLength={3}
              />
              {!!manualHRVError && <Text style={styles.manualHRVError}>{manualHRVError}</Text>}
              <Text style={styles.manualHRVNote}>HRV is measured in milliseconds (ms). Typical range: 20–100 ms.</Text>
              <TouchableOpacity
                style={styles.manualHRVSaveBtn}
                onPress={async () => {
                  const v = parseInt(manualHRVInput, 10);
                  if (!v || v < 1 || v > 200) { setManualHRVError('Enter a value between 1 and 200 ms'); return; }
                  const today = new Date().toLocaleDateString('en-CA');
                  await updateProfile({ manual_hrv: v, manual_hrv_date: today });
                  setManualHRVOpen(false);
                  if (profile?.id) loadHealthData(profile.id);
                }}
              >
                <Text style={styles.manualHRVSaveBtnText}>SAVE HRV</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setManualHRVOpen(false)} style={{ marginTop: 8, alignItems: 'center' }}>
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
        <InputAccessoryView nativeID="hrv-input-accessory">
          <View style={styles.inputAccessoryBar}>
            <TouchableOpacity onPress={() => Keyboard.dismiss()} style={styles.inputAccessoryDoneBtn}>
              <Text style={styles.inputAccessoryDoneText}>Done</Text>
            </TouchableOpacity>
          </View>
        </InputAccessoryView>
      </Modal>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 60 }}>
        {/* Name + badge */}
        <View style={styles.nameBlock}>
          <Text style={styles.name}>
            {profile?.first_name ?? ''} {profile?.last_name ?? ''}
          </Text>
          {!!goalBadge && <Text style={styles.goalBadge}>{goalBadge}</Text>}
        </View>

        {/* Coached upsell — shown once after goal switch if not dismissed */}
        {showCoachedUpsell && (
          <View style={styles.coachedUpsellCard}>
            <Text style={styles.coachedUpsellTitle}>Level up with Peak 65 Coached</Text>
            <Text style={styles.coachedUpsellBody}>
              Get 1:1 coaching, weekly check-ins, and personalised programming adjustments from a real coach.
            </Text>
            <View style={styles.coachedUpsellBtns}>
              <TouchableOpacity
                style={styles.coachedLearnBtn}
                onPress={() => Alert.alert('Peak 65 Coached', 'Coming soon! Stay tuned for 1:1 coaching options.')}
              >
                <Text style={styles.coachedLearnText}>Learn More</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.coachedNoBtn}
                onPress={async () => {
                  setShowCoachedUpsell(false);
                  if (profile?.id) {
                    await supabase.from('profiles').update({ coached_upsell_dismissed: true }).eq('id', profile.id);
                  }
                }}
              >
                <Text style={styles.coachedNoText}>No thanks</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Program regen status banner */}
        {programRegenStatus !== 'idle' && (
          <View style={styles.regenBanner}>
            {programRegenStatus === 'regenerating' ? (
              <>
                <ActivityIndicator size="small" color={Colors.accent} style={{ marginRight: 8 }} />
                <Text style={styles.regenBannerText}>Updating your program...</Text>
              </>
            ) : (
              <Text style={styles.regenBannerText}>Your program has been updated ✓</Text>
            )}
          </View>
        )}

        {/* Training section — hidden for Pinnacle athletes. Every row below
            changes programming, and their coach owns that. */}
        {isElite ? (
          <>
            <Text style={styles.sectionHeading}>Training</Text>
            <View style={styles.section}>
              <Text style={styles.coachManagedNote}>Your coach manages your training plan.</Text>
            </View>
          </>
        ) : (
        <>
        <Text style={styles.sectionHeading}>Training</Text>
        <View style={styles.section}>
          <SettingRow label="Goal" value={GOAL_OPTIONS.find(o => o.value === profile?.goal)?.label ?? ''} onPress={() => {
            const newGoal = profile?.goal === 'hyrox' ? 'general_fitness' : 'hyrox';
            setTargetGoal(newGoal);
            setGsDivision(profile?.hyrox_division ?? '');
            setGsRaceDate('');
            setGsGoalTime('');
            setGsWeaknesses([]);
            setGsRunConfidence(3);
            setGsPrimaryGoal('');
            setGoalSwitchStep('confirm');
            setGoalSwitchOpen(true);
          }} />
          {profile?.goal === 'hyrox' && (
            <SettingRow label="Division" value={profile?.hyrox_division ?? ''} onPress={() => setPicker('division')} />
          )}
          <SettingRow label="Rest Days" value={profile?.rest_days != null ? `${profile.rest_days} day${profile.rest_days !== 1 ? 's' : ''}` : ''} onPress={() => setPicker('rest')} />
          <SettingRow label="Session Length" value={profile?.session_length === '60' ? '~1 hour' : profile?.session_length === '90' ? '~1.5–2 hours' : profile?.session_length ?? ''} onPress={() => setPicker('length')} />
          <SettingRow label="Availability" value={profile?.availability === 'once' ? 'Once a day' : profile?.availability === 'both' ? 'Twice a day' : profile?.availability ?? ''} onPress={() => setPicker('availability')} />
          <SettingRow label="Equipment" value={toStringArray(profile?.equipment_access).join(', ')} onPress={() => setPicker('equipment')} />
          <TouchableOpacity style={styles.updateProgramRow} onPress={() => (navigation as any).navigate('UpdateProgram')}>
            <Text style={styles.updateProgramText}>Update My Program</Text>
            <Feather name="chevron-right" color={Colors.accent} size={16} />
          </TouchableOpacity>
        </View>
        </>
        )}

        {/* Wearables section */}
        <Text style={styles.sectionHeading}>Wearables</Text>
        {!profile?.wearable_connected && Platform.OS === 'ios' && (
          <View style={styles.wearableBanner}>
            <Text style={styles.wearableBannerText}>No wearable connected — link Apple Health for live readiness data.</Text>
            <TouchableOpacity onPress={connectAppleHealth} disabled={healthConnecting} style={styles.wearableBannerBtn}>
              <Text style={styles.wearableBannerBtnText}>{healthConnecting ? 'Connecting...' : 'Connect Apple Health'}</Text>
            </TouchableOpacity>
          </View>
        )}
        <View style={styles.section}>
          {/* Apple Health row — custom to handle connect/connected state */}
          {(() => {
            const isConnected = profile?.wearable_connected === true &&
                                profile?.wearable_type === 'apple_health';
            const isIOS = Platform.OS === 'ios';
            return (
              <TouchableOpacity
                style={styles.settingRow}
                onPress={isConnected || !isIOS ? undefined : connectAppleHealth}
                disabled={isConnected || healthConnecting || !isIOS}
              >
                <Text style={styles.settingLabel}>Apple Health</Text>
                <View style={styles.settingRight}>
                  <Text style={[
                    styles.settingValue,
                    isConnected && { color: '#a8ff78' },
                  ]}>
                    {!isIOS ? 'iOS Only' :
                     healthConnecting ? 'Connecting...' :
                     isConnected ? 'Connected ✓' : 'Connect'}
                  </Text>
                  {!isConnected && isIOS && !healthConnecting && (
                    <Feather name="chevron-right" color={Colors.textSecondary} size={16} />
                  )}
                </View>
              </TouchableOpacity>
            );
          })()}
          {/* Whoop direct API row */}
          {(() => {
            const isConnected = !!(profile?.whoop_connected || profile?.whoop_access_token || profile?.whoop_refresh_token);
            const needsReconnect = isConnected && !profile?.whoop_refresh_token && !profile?.whoop_access_token;
            return (
              <View>
                <View style={styles.settingRow}>
                  <Text style={styles.settingLabel}>Whoop</Text>
                  <View style={[styles.settingRight, { flexShrink: 1 }]}>
                    {whoopConnecting ? (
                      <Text style={styles.settingValue} numberOfLines={1}>Connecting...</Text>
                    ) : isConnected && !needsReconnect ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 }}>
                        <Text style={[styles.settingValue, { color: '#a8ff78' }]} numberOfLines={1}>Connected ✓</Text>
                        <TouchableOpacity onPress={disconnectWhoop} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                          <Text style={[styles.settingValue, { color: Colors.textSecondary }]} numberOfLines={1}>Disconnect</Text>
                        </TouchableOpacity>
                      </View>
                    ) : (
                      <TouchableOpacity onPress={connectWhoop} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <Text style={[styles.settingValue, needsReconnect && { color: '#e8c44a' }]} numberOfLines={1}>
                          {needsReconnect ? 'Reconnect' : 'Connect'}
                        </Text>
                        <Feather name="chevron-right" color={Colors.textSecondary} size={16} />
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
                {needsReconnect && (
                  <Text style={[styles.healthSource, { paddingHorizontal: 16, paddingBottom: 10, color: '#e8c44a' }]}>
                    Tap to reconnect for uninterrupted access
                  </Text>
                )}
              </View>
            );
          })()}
          <SettingRow label="Garmin" value="Coming Soon" />
        </View>

        {/* Today's Health Data — only when Apple Health is connected */}
        {profile?.wearable_connected && profile?.wearable_type === 'apple_health' && (
          <>
            <View style={styles.healthSectionHeader}>
              <Text style={styles.healthSectionTitle}>Today's Health Data</Text>
              <TouchableOpacity
                onPress={() => { console.log('[profile] refresh pressed'); profile?.id && loadHealthData(profile.id); }}
                disabled={healthLoading}
                style={styles.refreshBtn}
              >
                {healthLoading
                  ? <ActivityIndicator size="small" color={Colors.accent} />
                  : <Text style={styles.refreshText}>Refresh</Text>}
              </TouchableOpacity>
            </View>
            <View style={styles.section}>
              {healthData?.hrv != null ? (
                <HealthReadingRow label="HRV" reading={healthData.hrv} unit=" ms"
                  confidence={wearableReadings?.hrv?.confidence} />
              ) : (
                <View style={styles.healthRow}>
                  <Text style={styles.settingLabel}>HRV</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <Text style={styles.settingValue}>--</Text>
                    <TouchableOpacity
                      style={styles.logHRVBtn}
                      onPress={() => { setManualHRVInput(''); setManualHRVError(''); setManualHRVOpen(true); }}
                    >
                      <Text style={styles.logHRVBtnText}>+ Log</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
              <HealthReadingRow label="Resting HR" reading={healthData?.restingHR ?? null} unit=" bpm"
                confidence={wearableReadings?.rhr?.confidence} />
              <HealthReadingRow label="Sleep" reading={healthData?.sleepHours ?? null} unit="h"
                confidence={wearableReadings?.sleep?.confidence} />
              <HealthReadingRow label="Steps" reading={healthData?.steps ?? null}
                formatValue={v => v.toLocaleString('en-US')}
                confidence={wearableReadings?.steps?.confidence} />
              <HealthReadingRow label="Active Cal" reading={healthData?.activeCalories ?? null}
                formatValue={v => v.toLocaleString('en-US')} unit=" kcal"
                confidence={wearableReadings?.activeCal?.confidence} />
              {tdeeMissingFields.length > 0 ? (
                <View style={styles.healthRow}>
                  <Text style={styles.settingLabel}>Total Cal</Text>
                  <View style={{ alignItems: 'flex-end', flex: 1, marginLeft: 12 }}>
                    <Text style={[styles.settingValue, { fontSize: 12 }]}>Complete your profile</Text>
                    <Text style={styles.healthSource}>Missing: {tdeeMissingFields.join(', ')}</Text>
                  </View>
                </View>
              ) : (
                <HealthReadingRow
                  label="Total Cal"
                  reading={healthData?.totalCalories ?? null}
                  formatValue={v => v.toLocaleString('en-US')}
                  unit=" kcal"
                  confidence={wearableReadings?.totalCal?.confidence}
                  onSourcePress={() => Alert.alert(
                    'Total Calories',
                    'Total daily calories combine your wearable workout data with a calculated estimate of your daily burn based on age, weight, height, sex, and training frequency. This estimate will improve over time as we learn your patterns.',
                  )}
                />
              )}
            </View>
          </>
        )}

        {/* Body Metrics section */}
        <Text style={styles.sectionHeading}>Body Metrics</Text>
        <View style={styles.section}>
          <SettingRow
            label="Gender"
            value={profile?.gender ? (profile.gender.charAt(0).toUpperCase() + profile.gender.slice(1)) : ''}
            onPress={() => setMetricsPicker('gender')}
          />
          <SettingRow
            label="Height"
            value={profile?.height_cm != null
              ? formatHeightDisplay(profile.height_cm, (profile.preferred_units ?? 'imperial') === 'imperial')
              : ''}
            onPress={() => setMetricsPicker('height')}
          />
          <SettingRow
            label="Weight"
            value={profile?.weight_kg != null
              ? formatWeightDisplay(profile.weight_kg, (profile.preferred_units ?? 'imperial') === 'imperial')
              : ''}
            onPress={() => setMetricsPicker('weight')}
          />
          <SettingRow
            label="Units"
            value={profile?.preferred_units === 'metric' ? 'Metric (kg, cm)' : 'Imperial (lb, ft/in)'}
            onPress={() => setMetricsPicker('units')}
          />
          <SettingRow
            label="Date of Birth"
            value={profile?.date_of_birth
              ? new Date(profile.date_of_birth + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
              : ''}
            onPress={() => {
              const seed = profile?.date_of_birth
                ? new Date(profile.date_of_birth + 'T12:00:00')
                : (() => { const d = new Date(); d.setFullYear(d.getFullYear() - 25); return d; })();
              setDobPickerDate(seed);
              setMetricsPicker('dob');
            }}
          />
        </View>

        {/* Body section */}
        <Text style={styles.sectionHeading}>Body</Text>
        <View style={styles.section}>
          <SettingRow
            label="Body Fat Range"
            value={BF_OPTIONS.find(o => o.value === profile?.body_fat_range)?.label ?? profile?.body_fat_range ?? ''}
            onPress={() => setPicker('bf')}
          />
        </View>

        {/* Account section */}
        <Text style={styles.sectionHeading}>Account</Text>
        <View style={styles.section}>
          <SettingRow label="Email" value={email} />
          <SettingRow label="Subscription" value={`${isElite ? 'Pinnacle' : 'Foundation'} • Active`} />
        </View>

        {/* Sign out */}
        <TouchableOpacity style={styles.signOutBtn} onPress={handleSignOut}>
          <Text style={styles.signOutText}>SIGN OUT</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

  coachManagedNote: {
    color: Colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },

  nameBlock: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 16 },
  name: { color: Colors.textPrimary, fontSize: 24, fontWeight: '800' },
  goalBadge: { color: Colors.textSecondary, fontSize: 14, marginTop: 4 },

  sectionHeading: {
    color: Colors.textSecondary, fontSize: 11, fontWeight: '700', letterSpacing: 1.5,
    textTransform: 'uppercase', paddingHorizontal: 20, marginTop: 20, marginBottom: 8,
  },
  section: {
    marginHorizontal: 16, backgroundColor: Colors.card, borderRadius: 14, overflow: 'hidden',
  },
  settingRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 15,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#222',
  },
  settingLabel: { color: Colors.textPrimary, fontSize: 15 },
  settingRight: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '55%' },
  settingValue: { color: Colors.textSecondary, fontSize: 14, textAlign: 'right', flexShrink: 1 },
  settingChevron: { color: Colors.textSecondary, fontSize: 18 },

  healthSectionHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, marginTop: 20, marginBottom: 8,
  },
  healthSectionTitle: {
    color: Colors.textSecondary, fontSize: 11, fontWeight: '700', letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  refreshBtn: { paddingHorizontal: 12, paddingVertical: 4 },
  refreshText: { color: Colors.accent, fontSize: 13, fontWeight: '600' },
  healthRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#222',
  },
  healthSource: { color: Colors.textSecondary, fontSize: 11, marginTop: 2 },

  signOutBtn: {
    marginHorizontal: 16, marginTop: 24, backgroundColor: '#1a0000',
    borderRadius: 12, paddingVertical: 16, alignItems: 'center',
  },
  signOutText: { color: '#ff4444', fontSize: 16, fontWeight: '700' },

  // Picker
  pickerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  pickerSheet: {
    backgroundColor: Colors.card, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, paddingBottom: 40,
  },
  pickerTitle: { color: Colors.textPrimary, fontSize: 16, fontWeight: '700', marginBottom: 14, textAlign: 'center' },
  pickerOption: {
    paddingVertical: 14, paddingHorizontal: 16, backgroundColor: '#1a1a1a',
    borderRadius: 10, marginBottom: 8,
  },
  pickerOptionActive: { backgroundColor: Colors.accent },
  pickerOptionText: { color: Colors.textPrimary, fontSize: 15 },
  cancelText: { color: Colors.textSecondary, fontSize: 15, textAlign: 'center' },
  saveBtn: {
    backgroundColor: Colors.accent, borderRadius: 10, paddingVertical: 14,
    alignItems: 'center', marginTop: 12,
  },
  saveBtnText: { color: Colors.background, fontSize: 15, fontWeight: '700' },

  // + Log HRV button inline with HRV row
  logHRVBtn: {
    borderWidth: 1, borderColor: Colors.accent, borderRadius: 6,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  logHRVBtnText: { color: Colors.accent, fontSize: 11, fontWeight: '700' },

  // Manual HRV modal
  manualHRVCard: {
    backgroundColor: '#1a1a1a', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 24, gap: 14,
  },
  inputAccessoryBar: {
    backgroundColor: '#1c1c1e', borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#3a3a3c', paddingVertical: 8, paddingHorizontal: 16,
    alignItems: 'flex-end',
  },
  inputAccessoryDoneBtn: { paddingHorizontal: 12, paddingVertical: 4 },
  inputAccessoryDoneText: { color: Colors.accent, fontSize: 16, fontWeight: '600' },
  manualHRVTitle:  { color: Colors.textPrimary, fontSize: 18, fontWeight: '800' },
  manualHRVSub:    { color: Colors.textSecondary, fontSize: 13, lineHeight: 18 },
  manualHRVInput:  {
    backgroundColor: '#1a1a1a', borderWidth: 1.5, borderColor: '#2a2a2a',
    borderRadius: 10, paddingHorizontal: 16, paddingVertical: 14,
    color: Colors.textPrimary, fontSize: 32, fontWeight: '700', textAlign: 'center',
  },
  manualHRVError:  { color: '#ff4444', fontSize: 12 },
  manualHRVNote:   { color: Colors.textSecondary, fontSize: 11, lineHeight: 16 },
  manualHRVSaveBtn: {
    backgroundColor: Colors.accent, borderRadius: 12, paddingVertical: 16, alignItems: 'center',
  },
  manualHRVSaveBtnText: { color: Colors.background, fontSize: 15, fontWeight: '800', letterSpacing: 1 },

  // Goal switching modal
  gsGoalRow:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, marginVertical: 16 },
  gsGoalChip:        { backgroundColor: '#1a1a1a', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderColor: '#333' },
  gsGoalChipNew:     { backgroundColor: Colors.accent, borderColor: Colors.accent },
  gsGoalChipText:    { color: Colors.textPrimary, fontSize: 14, fontWeight: '700' },
  gsArrow:           { color: Colors.textSecondary, fontSize: 20 },
  gsSub:             { color: Colors.textSecondary, fontSize: 13, lineHeight: 18, textAlign: 'center', marginBottom: 12 },
  gsFieldLabel:      { color: Colors.textSecondary, fontSize: 11, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', marginTop: 16, marginBottom: 6 },
  gsTextInput: {
    backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#2a2a2a',
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12,
    color: Colors.textPrimary, fontSize: 16, marginBottom: 4,
  },
  gsConfidenceRow:     { flexDirection: 'row', gap: 8, marginVertical: 8 },
  gsConfidenceBtn:     { flex: 1, backgroundColor: '#1a1a1a', borderRadius: 10, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: '#333' },
  gsConfidenceBtnActive: { backgroundColor: Colors.accent, borderColor: Colors.accent },
  gsConfidenceBtnText: { color: Colors.textPrimary, fontSize: 16, fontWeight: '700' },

  // Coached upsell card
  coachedUpsellCard: {
    marginHorizontal: 16, marginTop: 16, backgroundColor: '#111',
    borderRadius: 14, padding: 18, borderLeftWidth: 3, borderLeftColor: Colors.accent, gap: 10,
  },
  coachedUpsellTitle: { color: Colors.textPrimary, fontSize: 15, fontWeight: '800' },
  coachedUpsellBody:  { color: Colors.textSecondary, fontSize: 13, lineHeight: 18 },
  coachedUpsellBtns:  { flexDirection: 'row', gap: 10, marginTop: 4 },
  coachedLearnBtn:    { flex: 1, backgroundColor: Colors.accent, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  coachedLearnText:   { color: Colors.background, fontSize: 13, fontWeight: '700' },
  coachedNoBtn:       { flex: 1, backgroundColor: '#1a1a1a', borderRadius: 10, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: '#333' },
  coachedNoText:      { color: Colors.textSecondary, fontSize: 13, fontWeight: '600' },

  // Program regen banner
  regenBanner: {
    marginHorizontal: 16, marginTop: 8, backgroundColor: '#111',
    borderRadius: 12, padding: 14, flexDirection: 'row', alignItems: 'center',
    borderLeftWidth: 3, borderLeftColor: Colors.accent,
  },
  regenBannerText: { color: Colors.textPrimary, fontSize: 14, fontWeight: '600' },

  // Wearable connection banner
  wearableBanner: {
    marginHorizontal: 16, marginBottom: 8, backgroundColor: '#1a1500',
    borderRadius: 12, padding: 14, gap: 10, borderWidth: 1, borderColor: '#3a3000',
  },
  wearableBannerText: { color: '#e8c44a', fontSize: 13, lineHeight: 18 },
  wearableBannerBtn:  { backgroundColor: Colors.accent, borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  wearableBannerBtnText: { color: Colors.background, fontSize: 13, fontWeight: '700' },

  // Update My Program row
  updateProgramRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 15,
  },
  updateProgramText: { color: Colors.accent, fontSize: 15, fontWeight: '600' },
});
