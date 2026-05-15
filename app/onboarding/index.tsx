import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  ActivityIndicator, Platform, KeyboardAvoidingView, Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as Notifications from 'expo-notifications';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { supabase } from '../../lib/supabase';
import type { MainStackParamList } from '../_layout';
import { Colors, Fonts } from '../../lib/theme';
import { Feather } from '@expo/vector-icons';
import RadarChart from '../components/RadarChart';
import type { StationValues } from '../components/RadarChart';
import {
  fetchDivisionStats, searchAthletes, fetchAthleteResults,
  weeksFromToday, getDivisionPresets, parseTimeToSecs,
  type HyroxEvent, type DivisionStats, type AthleteSearchResult, type AthleteRaceResult, type StationSplits, type HyroxAthlete,
} from '../../lib/hyroxApi';

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = NativeStackScreenProps<MainStackParamList, 'Onboarding'>;

type OnboardingData = {
  first_name: string;
  last_name: string;
  date_of_birth: string;
  gender: string;
  height_cm: number;
  weight_kg: number;
  units: 'imperial' | 'metric';
  goal: 'hyrox' | 'general_fitness' | '';
  training_background: string;
  primary_goals: string[];
  what_matters_most: string;
  body_fat: string;
  race_date: string;
  race_event_name: string;
  race_event_city: string;
  weeks_to_race: number | null;
  hyrox_format: string;
  hyrox_division: string;
  hyrox_goal_time: string;
  hyrox_goal_percentile: string;
  race_data_source: string;
  previous_race_id: string;
  previous_race_name: string;
  previous_race_time: string;
  station_splits: Record<string, string> | null;
  station_confidence: Record<string, number | null> | null;
  hyrox_weaknesses: string[];
  hyrox_equipment: string;
  hyrox_has_raced: string;
  equipment_access: string;
  hyrox_equipment_list: string[];
  training_days: string[];
  training_days_count: number;
  training_availability: string;
  doubles_eligible: boolean | null;
  doubles_days: string[];
  session_length: string;
  has_injuries: boolean;
  injury_notes: string;
  wearable: string[];
  referral_source: string;
  run_splits?: Record<string, string>;
  roxzone_time?: string;
};

type StepKey =
  | 'goal'
  | 'hyroxRace' | 'hyroxFormat' | 'hyroxGoalTime' | 'hyroxHistory'
  | 'hyroxResultsImport' | 'hyroxStationConf' | 'hyroxRadarChart' | 'hyroxRaceDay'
  | 'hyroxBackground'
  | 'gfBackground' | 'gfPrimaryGoals' | 'gfBodyFat'
  | 'aboutYou' | 'injuries'
  | 'trainingSetup' | 'gfEquipment'
  | 'trainingDays' | 'sessionDetails' | 'wearable' | 'referral'
  | 'gfClosing' | 'onboardingSummary';

type ClosingPhase = null | 'saving' | 'push' | 'assessment' | 'startdate' | 'generating';

// ─── Constants ────────────────────────────────────────────────────────────────

const STATION_KEYS = ['ski_erg','sled_push','sled_pull','burpee_broad_jumps','row_erg','farmers_carry','sandbag_lunges','wall_balls'] as const;
const STATION_LABELS: Record<string, string> = {
  ski_erg: 'Ski Erg', sled_push: 'Sled Push', sled_pull: 'Sled Pull',
  burpee_broad_jumps: 'Burpee Broad Jumps', row_erg: 'Row Erg',
  farmers_carry: 'Farmers Carry', sandbag_lunges: 'Sandbag Lunges', wall_balls: 'Wall Balls',
};
const WEEK_DAYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
const WEEK_LABELS = ['M','T','W','T','F','S','S'];
const ALL_INDIVIDUAL_GOALS = ['build_muscle', 'lose_weight', 'look_better', 'run_faster', 'get_stronger'];

const DOB_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DOB_DAYS = Array.from({ length: 31 }, (_, i) => String(i + 1));
const DOB_YEARS = Array.from({ length: 87 }, (_, i) => String(2013 - i));

const COACHING_CARDS = [
  'Peak 65 programs threshold sessions before strength — because lifting fatigue changes your heart rate zones. Your zones are always protected.',
  'Your Peak Score isn\'t a readiness score. It\'s a coaching decision. When it drops, we adjust your program before you even open the app.',
  'Zone 2 feels too easy. That\'s the point. 70% of your training happens here because it\'s where your aerobic engine actually builds.',
  'Hyrox isn\'t decided by how fast you can run fresh. It\'s decided by how much of that speed you can hold onto across 60 minutes of work.',
  'The threshold interval cap is 6 minutes. Not because longer doesn\'t work — because your 1km race segment takes 4-5 minutes. We train the race, not around it.',
  'The athletes who win races are the ones who show up in week 4 when it\'s not exciting anymore. We\'ll be here every week.',
];

const CHECKLIST_ITEMS = [
  'Analyzing your profile',
  'Applying Peak 65 coaching system',
  'Calibrating your threshold zones',
  'Building your training plan...',
];


// ─── Step Logic ───────────────────────────────────────────────────────────────

function getSteps(data: OnboardingData): StepKey[] {
  if (data.goal === 'hyrox') {
    const steps: StepKey[] = ['goal', 'hyroxBackground', 'aboutYou', 'hyroxRace', 'hyroxFormat', 'hyroxGoalTime', 'hyroxHistory'];
    if (data.hyrox_has_raced === 'yes') steps.push('hyroxResultsImport');
    const hasRealSplits = (data.race_data_source === 'api' || data.race_data_source === 'manual') && data.station_splits !== null;
    if (!hasRealSplits) steps.push('hyroxStationConf');
    steps.push('hyroxRadarChart', 'hyroxRaceDay');
    steps.push('injuries', 'trainingSetup', 'trainingDays', 'sessionDetails', 'wearable', 'referral', 'onboardingSummary');
    return steps;
  }
  if (data.goal === 'general_fitness') {
    const steps: StepKey[] = ['goal', 'gfBackground', 'gfPrimaryGoals', 'aboutYou'];
    if (data.primary_goals.some(g => ['lose_weight', 'look_better', 'all'].includes(g))) steps.push('gfBodyFat');
    steps.push('injuries', 'gfEquipment', 'trainingDays', 'sessionDetails', 'wearable', 'referral', 'gfClosing', 'onboardingSummary');
    return steps;
  }
  return ['goal'];
}

function isStepComplete(key: StepKey, d: OnboardingData): boolean {
  switch (key) {
    case 'goal':              return d.goal !== '';
    case 'hyroxRace':         return true;
    case 'hyroxFormat':       return d.hyrox_division !== '';
    case 'hyroxGoalTime':     return d.hyrox_goal_time !== '';
    case 'hyroxHistory':      return d.hyrox_has_raced !== '';
    case 'hyroxResultsImport':return d.race_data_source !== '';
    case 'hyroxStationConf':  return true;
    case 'hyroxRadarChart':   return true;
    case 'hyroxRaceDay':      return true;
    case 'hyroxBackground':   return d.training_background !== '';
    case 'gfBackground':      return d.training_background !== '';
    case 'gfPrimaryGoals':    return d.primary_goals.length > 0;
    case 'gfBodyFat':         return d.body_fat !== '';
    case 'aboutYou':          return d.gender !== '' && d.height_cm > 0 && d.weight_kg > 0 && d.date_of_birth !== '' && d.date_of_birth !== '1990-01-01';
    case 'injuries':          return true;
    case 'trainingSetup':     return d.equipment_access !== '';
    case 'gfEquipment':       return d.equipment_access !== '';
    case 'trainingDays':      return d.training_days.length >= 2;
    case 'sessionDetails':
      if (!d.training_availability || !d.session_length) return false;
      if (d.training_availability === 'both') {
        if (d.doubles_eligible === null) return false;
        if (d.doubles_eligible === true) return d.doubles_days.length > 0;
      }
      return true;
    case 'wearable':          return d.wearable.length > 0;
    case 'referral':          return true;
    case 'gfClosing':         return true;
    case 'onboardingSummary': return true;
    default:                  return false;
  }
}

function determineFitnessLevel(d: OnboardingData): 'beginner' | 'intermediate' | 'advanced' {
  let score = 0;
  const days = d.training_days_count;
  if (days >= 6) score += 2;
  else if (days >= 4) score += 1;
  if (d.training_background === 'hyrox') score += 3;
  else if (d.training_background === 'crossfit') score += 2;
  else if (d.training_background === 'endurance') score += 2;
  else if (d.training_background === 'gym') score += 1;
  else if (d.training_background === 'beginner') score -= 1;
  if (d.race_data_source === 'api' || d.race_data_source === 'manual') score += 2;
  if (d.date_of_birth) {
    const birth = new Date(d.date_of_birth);
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const diffM = today.getMonth() - birth.getMonth();
    if (diffM < 0 || (diffM === 0 && today.getDate() < birth.getDate())) age--;
    if (age >= 45) score -= 1;
  }
  if (score >= 6) return 'advanced';
  if (score >= 3) return 'intermediate';
  return 'beginner';
}

function deriveWhatMattersMost(goals: string[]): string {
  if (goals.includes('run_faster') || goals.includes('get_stronger')) return 'performance';
  if (goals.includes('lose_weight') || goals.includes('look_better')) return 'aesthetics';
  if (goals.includes('build_muscle')) return 'aesthetics';
  return 'performance';
}

function secsToMMSS(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function weaknessesToRadarValues(weaknesses: string[]): StationValues {
  const result: StationValues = {};
  if (weaknesses.length === 0) {
    STATION_KEYS.forEach(k => { result[k] = 3 / 5; });
  } else {
    STATION_KEYS.forEach(k => {
      result[k] = weaknesses.includes(k) ? 2 / 5 : 4 / 5;
    });
  }
  return result;
}

function getDivisionBenchmarks(division: string, goalTimeMinutes: number): StationValues {
  let score: number;
  if (goalTimeMinutes < 60) score = 1.0;
  else if (goalTimeMinutes < 70) score = 0.9;
  else if (goalTimeMinutes < 80) score = 0.8;
  else if (goalTimeMinutes < 90) score = 0.7;
  else if (goalTimeMinutes < 100) score = 0.6;
  else score = 0.5;
  const result: StationValues = {};
  STATION_KEYS.forEach(k => { result[k] = score; });
  return result;
}

function splitsToRadarValues(splits: Record<string, string>): StationValues {
  const secsMap: Record<string, number> = {};
  STATION_KEYS.forEach(k => {
    const t = splits[k];
    if (t) secsMap[k] = parseTimeToSecs(t);
  });
  const times = STATION_KEYS.map(k => secsMap[k]).filter(v => v && v > 0) as number[];
  if (times.length === 0) return weaknessesToRadarValues([]);
  const maxSecs = Math.max(...times);
  const minSecs = Math.min(...times);
  const range = maxSecs - minSecs || 1;
  const result: StationValues = {};
  STATION_KEYS.forEach(k => {
    const s = secsMap[k];
    result[k] = s ? 0.2 + 0.8 * ((maxSecs - s) / range) : 0.5;
  });
  return result;
}

// ─── DrumRollPicker (unchanged from original) ─────────────────────────────────

const DRUM_ITEM_H = 44;
const DRUM_H      = DRUM_ITEM_H * 3;
const DRUM_PAD    = DRUM_ITEM_H * 1;

const HEIGHT_IMPERIAL_ITEMS = (() => { const a: string[] = []; for (let i = 54; i <= 84; i++) a.push(`${Math.floor(i/12)}' ${i%12}"`); return a; })();
const HEIGHT_METRIC_ITEMS   = (() => { const a: string[] = []; for (let i = 137; i <= 213; i++) a.push(`${i} cm`); return a; })();
const WEIGHT_IMPERIAL_ITEMS = (() => { const a: string[] = []; for (let i = 80; i <= 350; i++) a.push(`${i} lbs`); return a; })();
const WEIGHT_METRIC_ITEMS   = (() => { const a: string[] = []; for (let i = 0; i <= 246; i++) a.push(`${(36 + i*0.5).toFixed(1)} kg`); return a; })();

function DrumRollPicker({ items, selectedIndex, onChange }: { items: string[]; selectedIndex: number; onChange: (i: number) => void }) {
  const listRef = useRef<ScrollView>(null);
  const [hlIdx, setHlIdx] = useState(selectedIndex);
  useEffect(() => {
    const t = setTimeout(() => listRef.current?.scrollTo({ y: Math.max(0, selectedIndex) * DRUM_ITEM_H, animated: false }), 80);
    return () => clearTimeout(t);
  }, []);
  function handleScrollEnd(e: any) {
    const idx = Math.round(e.nativeEvent.contentOffset.y / DRUM_ITEM_H);
    const c = Math.max(0, Math.min(items.length - 1, idx));
    setHlIdx(c); onChange(c);
  }
  return (
    <View style={{ height: DRUM_H, overflow: 'hidden' }}>
      <ScrollView ref={listRef} snapToInterval={DRUM_ITEM_H} decelerationRate="fast"
        showsVerticalScrollIndicator={false} nestedScrollEnabled contentContainerStyle={{ paddingVertical: DRUM_PAD }}
        onScroll={e => { const idx = Math.round(e.nativeEvent.contentOffset.y / DRUM_ITEM_H); setHlIdx(Math.max(0, Math.min(items.length-1, idx))); }}
        scrollEventThrottle={50} onMomentumScrollEnd={handleScrollEnd} onScrollEndDrag={handleScrollEnd}>
        {items.map((item, index) => {
          const dist = Math.abs(index - hlIdx);
          return (
            <View key={String(index)} style={{ height: DRUM_ITEM_H, justifyContent: 'center', alignItems: 'center' }}>
              <Text style={{ color: dist===0 ? Colors.accent : '#8a877f', fontSize: dist===0 ? 28 : dist===1 ? 22 : 18, fontWeight: dist===0 ? '700' : '400', opacity: dist===0 ? 1 : dist===1 ? 0.65 : 0.3 }}>{item}</Text>
            </View>
          );
        })}
      </ScrollView>
      <View style={{ position:'absolute', top:0, left:0, right:0, height:DRUM_PAD, backgroundColor:'rgba(8,8,8,0.72)' }} pointerEvents="none" />
      <View style={{ position:'absolute', bottom:0, left:0, right:0, height:DRUM_PAD, backgroundColor:'rgba(8,8,8,0.72)' }} pointerEvents="none" />
      <View style={{ position:'absolute', top:DRUM_PAD, left:0, right:0, height:DRUM_ITEM_H, borderTopWidth:1, borderBottomWidth:1, borderColor:'rgba(232,255,71,0.3)' }} pointerEvents="none" />
    </View>
  );
}

// ─── Initial state ─────────────────────────────────────────────────────────────

const INITIAL: OnboardingData = {
  first_name: '', last_name: '', date_of_birth: '1990-01-01', gender: '',
  height_cm: 173, weight_kg: 75, units: 'imperial',
  goal: '', training_background: '',
  primary_goals: [], what_matters_most: '', body_fat: '',
  race_date: '', race_event_name: '', race_event_city: '', weeks_to_race: null,
  hyrox_format: '', hyrox_division: '', hyrox_goal_time: '', hyrox_goal_percentile: '',
  race_data_source: '', previous_race_id: '', previous_race_name: '', previous_race_time: '',
  station_splits: null, station_confidence: null, hyrox_weaknesses: [], hyrox_equipment: '', hyrox_has_raced: '',
  equipment_access: '', hyrox_equipment_list: [], training_days: [], training_days_count: 0,
  training_availability: '', doubles_eligible: null, doubles_days: [], session_length: '',
  has_injuries: false, injury_notes: '', wearable: [], referral_source: '',
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function OnboardingScreen({ navigation }: Props) {
  const [showSplash, setShowSplash]     = useState(true);
  const [step, setStep]                 = useState(0);
  const [data, setData]                 = useState<OnboardingData>(INITIAL);
  const [closingPhase, setClosingPhase] = useState<ClosingPhase>(null);
  const [selectedStartDate, setSelectedStartDate] = useState<Date | null>(null);
  const [apiError, setApiError]         = useState(false);
  const [checklistStep, setChecklistStep] = useState(0);
  const [cardIdx, setCardIdx]           = useState(0);
  const [androidPickerOpen, setAndroidPickerOpen] = useState(false);

  // Hyrox API state
  const [divStats, setDivStats]         = useState<DivisionStats | null>(null);
  const [goalHours, setGoalHours]       = useState('1');
  const [goalMins, setGoalMins]         = useState('15');
  const [searchQuery, setSearchQuery]   = useState('');
  const [searchResults, setSearchResults] = useState<AthleteSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [athleteRaces, setAthleteRaces] = useState<AthleteRaceResult[]>([]);
  const [racesLoading, setRacesLoading] = useState(false);
  const [showManualSplits, setShowManualSplits] = useState(false);
  const [manualSplits, setManualSplits] = useState<Record<string, string>>({});
  const [customDateObj, setCustomDateObj] = useState<Date | null>(null);
  const [dobMonthIdx, setDobMonthIdx] = useState(0);
  const [dobDayIdx, setDobDayIdx] = useState(0);
  const [dobYearIdx, setDobYearIdx] = useState(23); // 1990
  const [goalPickerKey, setGoalPickerKey] = useState(0);

  const stepOpacity = useRef(new Animated.Value(1)).current;

  const steps       = getSteps(data);
  const totalSteps  = steps.length;
  const currentKey  = steps[Math.min(step, totalSteps - 1)];
  const progress    = totalSteps > 1 ? (step + 1) / totalSteps : 0;
  const canContinue = isStepComplete(currentKey, data);
  const isLastStep  = step === totalSteps - 1;

  // ── Effects ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    supabase.auth.getUser().then(({ data: auth }) => {
      if (!auth.user) return;
      supabase.from('profiles').select('first_name,last_name').eq('id', auth.user.id).maybeSingle()
        .then(({ data: p }) => {
          if (p?.first_name) setData(prev => ({ ...prev, first_name: p.first_name, last_name: p.last_name ?? '' }));
        });
    });
  }, []);

  useEffect(() => {
    if (currentKey === 'hyroxGoalTime' && data.hyrox_division && !divStats) {
      fetchDivisionStats(data.hyrox_division).then(s => setDivStats(s));
    }
    if (currentKey === 'hyroxGoalTime') {
      const defaultTime = getDivisionPresets(data.hyrox_division || 'men-open')[0].time;
      const [h, m] = (data.hyrox_goal_time || defaultTime).split(':');
      setGoalHours(h || '1');
      setGoalMins(m || '30');
      if (!data.hyrox_goal_time) {
        setData(prev => ({ ...prev, hyrox_goal_time: defaultTime }));
      }
    }
  }, [currentKey]);

  // Saving checklist ticker
  useEffect(() => {
    if (closingPhase !== 'saving') return;
    if (checklistStep >= CHECKLIST_ITEMS.length - 1) return;
    const id = setTimeout(() => setChecklistStep(s => s + 1), 2000);
    return () => clearTimeout(id);
  }, [closingPhase, checklistStep]);

  // Coaching card rotator
  useEffect(() => {
    if (closingPhase !== 'saving') return;
    const id = setInterval(() => setCardIdx(i => (i + 1) % COACHING_CARDS.length), 3000);
    return () => clearInterval(id);
  }, [closingPhase]);

  // Generating checklist ticker
  useEffect(() => {
    if (closingPhase !== 'generating') return;
    if (checklistStep >= 4) return;
    const t = setTimeout(() => setChecklistStep(s => s + 1), 2000);
    return () => clearTimeout(t);
  }, [closingPhase, checklistStep]);

  // Default selectedStartDate to first training day in next 7 days
  useEffect(() => {
    if (closingPhase !== 'startdate') return;
    const next7: Date[] = [];
    for (let i = 1; i <= 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      next7.push(d);
    }
    const first = next7.find(d =>
      (data.training_days as string[]).includes(d.toLocaleDateString('en-US', { weekday: 'long' }))
    );
    if (first) setSelectedStartDate(first);
  }, [closingPhase]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Navigation ────────────────────────────────────────────────────────────────

  function fade(callback: () => void) {
    Animated.timing(stepOpacity, { toValue: 0, duration: 70, useNativeDriver: true }).start(() => {
      callback();
      Animated.timing(stepOpacity, { toValue: 1, duration: 70, useNativeDriver: true }).start();
    });
  }

  function handleNext() {
    if (isLastStep) { handleSubmit(); return; }
    fade(() => setStep(s => s + 1));
  }

  function handleBack() {
    if (step > 0) fade(() => setStep(s => s - 1));
  }

  function autoAdvance(updater: Partial<OnboardingData>) {
    const newData = { ...data, ...updater };
    const newSteps = getSteps(newData);
    const curIdx = newSteps.indexOf(currentKey);
    fade(() => {
      setData(newData);
      setStep(curIdx + 1);
    });
  }

  function skipStep() {
    fade(() => setStep(s => s + 1));
  }

  // ── State helpers ─────────────────────────────────────────────────────────────

  function set<K extends keyof OnboardingData>(field: K, value: OnboardingData[K]) {
    setData(prev => ({ ...prev, [field]: value }));
  }

  function togglePrimaryGoal(value: string) {
    setData(prev => {
      const arr = prev.primary_goals;
      if (value === 'all') {
        if (arr.includes('all')) return { ...prev, primary_goals: [] };
        return { ...prev, primary_goals: [...ALL_INDIVIDUAL_GOALS, 'all'] };
      }
      const withoutAll = arr.filter(v => v !== 'all');
      const next = withoutAll.includes(value)
        ? withoutAll.filter(v => v !== value)
        : [...withoutAll, value];
      const allSelected = ALL_INDIVIDUAL_GOALS.every(g => next.includes(g));
      return { ...prev, primary_goals: allSelected ? [...next, 'all'] : next };
    });
  }

  function toggleWearable(value: string) {
    setData(prev => {
      if (value === 'none') return { ...prev, wearable: ['none'] };
      const withoutNone = prev.wearable.filter(v => v !== 'none');
      const next = withoutNone.includes(value)
        ? withoutNone.filter(v => v !== value)
        : [...withoutNone, value];
      return { ...prev, wearable: next };
    });
  }

  function toggleEquipment(item: string) {
    setData(prev => {
      const next = prev.hyrox_equipment_list.includes(item)
        ? prev.hyrox_equipment_list.filter(v => v !== item)
        : [...prev.hyrox_equipment_list, item];
      return { ...prev, hyrox_equipment_list: next };
    });
  }

  function toggleTrainingDay(day: string) {
    const capitalizedDay = day.charAt(0).toUpperCase() + day.slice(1);
    const dayOrder = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    setData(prev => {
      const arr = prev.training_days;
      const next = arr.includes(capitalizedDay)
        ? arr.filter(d => d !== capitalizedDay)
        : [...arr, capitalizedDay].sort((a, b) => dayOrder.indexOf(a) - dayOrder.indexOf(b));
      return { ...prev, training_days: next, training_days_count: next.length };
    });
  }

  function setGoalTime(h: string, m: string) {
    const hours = h.replace(/\D/g, '').slice(0, 1);
    const mins  = m.replace(/\D/g, '').slice(0, 2);
    setGoalHours(hours);
    setGoalMins(mins);
    if (hours && mins) set('hyrox_goal_time', `${hours}:${mins.padStart(2,'0')}`);
  }

  async function doSearch() {
    if (!searchQuery.trim()) return;
    setSearchLoading(true);
    setAthleteRaces([]);
    const parts = searchQuery.trim().split(/\s+/);
    const firstName = parts[0] ?? '';
    const lastName = parts.slice(1).join(' ');
    const results = await searchAthletes(firstName, lastName);
    setSearchResults(results);
    setSearchLoading(false);
  }

  async function selectAthlete(athlete: AthleteSearchResult) {
    setData(prev => ({
      ...prev,
      race_data_source: 'api',
      previous_race_name: athlete.location,
      previous_race_time: athlete.finish_time,
      station_splits: athlete.station_splits,
      run_splits: athlete.run_splits,
      roxzone_time: athlete.roxzone_time,
    }));
    fade(() => setStep(s => s + 1));
  }

  function useRaceResult(race: AthleteRaceResult) {
    setData(prev => ({
      ...prev,
      race_data_source: 'api',
      previous_race_id: race.id,
      previous_race_name: race.event_name,
      previous_race_time: race.finish_time,
      station_splits: race.splits as unknown as Record<string,string>,
    }));
    fade(() => setStep(s => s + 1));
  }

  function useManualSplits() {
    setData(prev => ({
      ...prev,
      race_data_source: 'manual',
      station_splits: manualSplits,
    }));
    fade(() => setStep(s => s + 1));
  }

  function skipResultsImport() {
    setData(prev => ({ ...prev, race_data_source: 'none', station_splits: null }));
    fade(() => setStep(s => s + 1));
  }

  // ── Submit / closing flow ─────────────────────────────────────────────────────

  const callGenerateAssessment = useCallback(async () => {
    setApiError(false);
    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) { setApiError(true); return; }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      const res = await fetch('https://peak65.vercel.app/api/generate-assessment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ userId: authData.user.id }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      navigation.replace('Tabs');
    } catch {
      clearTimeout(timeout);
      setApiError(true);
    }
  }, []);

  async function handleSubmit() {
    setClosingPhase('saving');
    setChecklistStep(0);

    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) return;

    const { error: upsertError } = await supabase.from('profiles').upsert({
      id: authData.user.id,
      first_name: data.first_name || null,
      last_name: data.last_name || null,
      date_of_birth: data.date_of_birth || null,
      gender: data.gender || null,
      height_cm: Math.round(data.height_cm),
      weight_kg: Math.round(data.weight_kg * 10) / 10,
      units: data.units,
      body_fat: data.body_fat || null,
      goal: data.goal,
      training_background: data.training_background || null,
      primary_goals: data.primary_goals.length > 0 ? data.primary_goals : null,
      what_matters_most: data.goal === 'general_fitness' ? deriveWhatMattersMost(data.primary_goals) : (data.what_matters_most || null),
      race_date: data.race_date || null,
      race_event_name: data.race_event_name || null,
      race_event_city: data.race_event_city || null,
      weeks_to_race: data.weeks_to_race,
      hyrox_format: data.hyrox_format || null,
      hyrox_division: data.hyrox_division || null,
      hyrox_goal_time: data.hyrox_goal_time || null,
      hyrox_goal_percentile: data.hyrox_goal_percentile || null,
      race_data_source: data.race_data_source || null,
      previous_race_id: data.previous_race_id || null,
      previous_race_name: data.previous_race_name || null,
      previous_race_time: data.previous_race_time || null,
      station_splits: data.station_splits,
      station_confidence: data.station_confidence,
      hyrox_weaknesses: data.hyrox_weaknesses.length > 0 ? data.hyrox_weaknesses : null,
      hyrox_equipment: data.hyrox_equipment || null,
      fitness_level: determineFitnessLevel(data),
      equipment_access: (data.equipment_access === 'dumbbells' ? 'home' : data.equipment_access) || null,
      training_days: data.training_days.length > 0 ? data.training_days : null,
      training_days_count: data.training_days_count || null,
      training_availability: data.training_availability || null,
      doubles_eligible: data.doubles_eligible,
      doubles_days: data.doubles_days.length > 0 ? data.doubles_days : null,
      session_length: data.session_length || null,
      has_injuries: data.has_injuries,
      injury_notes: data.injury_notes || null,
      wearable: data.wearable.length > 0 ? data.wearable : null,
      referral_source: data.referral_source || null,
      onboarding_complete: true,
      program_start_date: null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });

    if (upsertError) {
      console.error('[onboarding] profile upsert failed:', upsertError.message);
      Alert.alert('Something went wrong', 'We could not save your profile. Please try again.');
      return;
    }

    // Elite invite check (preserve existing logic)
    const userEmail = authData.user.email;
    if (userEmail) {
      const { data: existingLink } = await supabase.from('coach_athletes').select('id').eq('athlete_id', authData.user.id).maybeSingle();
      if (!existingLink) {
        const { data: invite } = await supabase.from('elite_invites').select('*').eq('email', userEmail).in('status', ['pending','accepted']).order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (invite) {
          await Promise.all([
            supabase.from('coach_athletes').insert({ coach_id: invite.coach_id, athlete_id: authData.user.id, tier: invite.tier ?? 'elite', status: 'active' }),
            supabase.from('profiles').update({ tier: invite.tier ?? 'elite', known_zones: invite.known_zones ?? null, program_status: 'awaiting_coach' }).eq('id', authData.user.id),
            supabase.from('elite_invites').update({ status: 'accepted', athlete_id: authData.user.id }).eq('id', invite.id),
          ]);
        }
      }
    }

    const { data: freshProfile } = await supabase.from('profiles').select('tier').eq('id', authData.user.id).maybeSingle();
    if ((freshProfile as any)?.tier === 'elite') {
      await supabase.from('profiles').update({ program_status: 'awaiting_coach' }).eq('id', authData.user.id);
      navigation.replace('Waiting');
      return;
    }

    setClosingPhase('push');
  }

  // ── Step renders ──────────────────────────────────────────────────────────────

  function renderGoal() {
    return (
      <View style={styles.stepContent}>
        <Text style={styles.label}>What's your goal?</Text>
        <TouchableOpacity style={[styles.goalCard, data.goal === 'hyrox' && styles.goalCardSelected]} onPress={() => autoAdvance({ goal: 'hyrox' })}>
          <View style={styles.goalCardInner}>
            <Feather name="zap" size={32} color={Colors.accent} />
            <Text style={[styles.goalCardTitle, data.goal === 'hyrox' && styles.goalCardTitleSelected]}>Hyrox Race</Text>
            <Text style={styles.goalCardSub}>Train for your next HYROX event with a race-specific program</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.goalCard, data.goal === 'general_fitness' && styles.goalCardSelected]} onPress={() => autoAdvance({ goal: 'general_fitness' })}>
          <View style={styles.goalCardInner}>
            <Feather name="activity" size={32} color={Colors.accent} />
            <Text style={[styles.goalCardTitle, data.goal === 'general_fitness' && styles.goalCardTitleSelected]}>General Fitness</Text>
            <Text style={styles.goalCardSub}>Build strength, endurance, and body composition on your terms</Text>
          </View>
        </TouchableOpacity>
      </View>
    );
  }

  function renderHyroxRace() {
    const pickerDate = customDateObj ?? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    return (
      <View style={[styles.stepContent, { flex: 1 }]}>
        <Text style={styles.label}>When are you racing?</Text>
        <Text style={styles.sublabel}>Select your race date</Text>
        <View style={{ gap: 12 }}>
          {Platform.OS === 'ios' ? (
            <DateTimePicker value={pickerDate} mode="date" display="inline" themeVariant="dark" accentColor={Colors.accent}
              minimumDate={new Date()}
              onChange={(_, d) => {
                if (d) {
                  setCustomDateObj(d);
                  set('race_date', d.toISOString().split('T')[0]);
                  set('weeks_to_race', weeksFromToday(d.toISOString().split('T')[0]));
                  set('race_event_name', '');
                  set('race_event_city', '');
                }
              }}
              style={{ backgroundColor: Colors.background }}
            />
          ) : (
            <>
              <TouchableOpacity style={styles.option} onPress={() => setAndroidPickerOpen(true)}>
                <Text style={styles.optionText}>{pickerDate.toLocaleDateString()}</Text>
              </TouchableOpacity>
              {androidPickerOpen && (
                <DateTimePicker value={pickerDate} mode="date" display="default" minimumDate={new Date()}
                  onChange={(_, d) => { setAndroidPickerOpen(false); if (d) { setCustomDateObj(d); set('race_date', d.toISOString().split('T')[0]); set('weeks_to_race', weeksFromToday(d.toISOString().split('T')[0])); } }}
                />
              )}
            </>
          )}
          <TouchableOpacity style={styles.skipBtn} onPress={() => { set('race_date', ''); set('weeks_to_race', null); skipStep(); }}>
            <Text style={styles.skipText}>I don't have a race date yet</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  function renderHyroxFormat() {
    const isFemale = data.gender === 'female';
    const currentFormat = data.hyrox_format;
    const grades = currentFormat === 'doubles' ? ['open', 'pro', 'mixed'] : ['open', 'pro'];

    const currentGrade = (() => {
      if (!data.hyrox_division) return '';
      if (data.hyrox_division.includes('mixed')) return 'mixed';
      if (data.hyrox_division.includes('pro')) return 'pro';
      return 'open';
    })();

    function selectFormat(fmt: string) {
      setData(prev => ({ ...prev, hyrox_format: fmt, hyrox_division: '' }));
    }

    function selectGrade(grade: string) {
      let div = '';
      if (currentFormat === 'doubles') {
        if (grade === 'mixed') div = 'mixed-doubles';
        else if (grade === 'pro') div = isFemale ? 'women-pro-doubles' : 'men-pro-doubles';
        else div = isFemale ? 'women-open-doubles' : 'men-open-doubles';
      } else {
        if (grade === 'pro') div = isFemale ? 'women-pro' : 'men-pro';
        else div = isFemale ? 'women-open' : 'men-open';
      }
      set('hyrox_division', div);
    }

    const gradeDesc = (grade: string) => {
      if (grade === 'mixed') return 'One male, one female partner';
      if (grade === 'pro') return 'Heavier weights — competitive division';
      return 'Standard weights — open division';
    };

    const divisionLabel = data.hyrox_division
      ? data.hyrox_division.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      : '';

    return (
      <View style={styles.stepContent}>
        <Text style={styles.label}>Choose your division.</Text>
        <Text style={styles.sublabel}>Select the format and grade you'll race in</Text>

        <View style={styles.twoCardRow}>
          <TouchableOpacity style={[styles.halfCard, { height: 80, gap: 6 }, currentFormat === 'singles' && styles.halfCardSelected]}
            onPress={() => selectFormat('singles')}>
            <Feather name="user" size={20} color={currentFormat === 'singles' ? '#e8ff47' : Colors.textSecondary} />
            <Text style={[styles.halfCardTitle, currentFormat === 'singles' && { color: '#e8ff47' }]}>Singles</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.halfCard, { height: 80, gap: 6 }, currentFormat === 'doubles' && styles.halfCardSelected]}
            onPress={() => selectFormat('doubles')}>
            <Feather name="users" size={20} color={currentFormat === 'doubles' ? '#e8ff47' : Colors.textSecondary} />
            <Text style={[styles.halfCardTitle, currentFormat === 'doubles' && { color: '#e8ff47' }]}>Doubles</Text>
          </TouchableOpacity>
        </View>

        {currentFormat !== '' && (
          <View style={styles.toggleRow}>
            {grades.map(g => (
              <TouchableOpacity key={g} style={[styles.toggleBtn, currentGrade === g && styles.toggleBtnActive]}
                onPress={() => selectGrade(g)}>
                <Text style={[styles.toggleBtnText, currentGrade === g && styles.toggleBtnTextActive]}>
                  {g.charAt(0).toUpperCase() + g.slice(1)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {data.hyrox_division && (
          <View style={{ backgroundColor: '#1a1a1a', borderLeftWidth: 3, borderLeftColor: '#e8ff47', borderRadius: 12, padding: 14, gap: 4 }}>
            <Text style={{ color: '#e8ff47', fontSize: 18, fontWeight: '700' }}>{divisionLabel}</Text>
            <Text style={{ color: '#8a877f', fontSize: 13 }}>{gradeDesc(currentGrade)}</Text>
          </View>
        )}
      </View>
    );
  }

  function renderHyroxGoalTime() {
    const presets = getDivisionPresets(data.hyrox_division || 'men-open');
    const HOURS_ITEMS = ['0', '1', '2'];
    const MINS_ITEMS = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));
    const hIdx = Math.max(0, Math.min(2, parseInt(goalHours || '1', 10)));
    const mIdx = Math.max(0, Math.min(59, parseInt(goalMins || '30', 10)));

    return (
      <View style={styles.stepContent}>
        <Text style={styles.label}>What's your 65?</Text>
        <Text style={styles.sublabel}>What finish time are you chasing?</Text>

        <Text style={{ color: Colors.accent, fontSize: 52, fontWeight: '700', textAlign: 'center', letterSpacing: -2 }}>
          {goalHours || '1'}:{(goalMins || '30').padStart(2, '0')}
        </Text>

        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.sectionHeader, { textAlign: 'center', marginBottom: 4 }]}>HRS</Text>
            <DrumRollPicker key={`h-${goalPickerKey}`} items={HOURS_ITEMS} selectedIndex={hIdx}
              onChange={i => setGoalTime(String(i), goalMins)} />
          </View>
          <View style={{ flex: 2 }}>
            <Text style={[styles.sectionHeader, { textAlign: 'center', marginBottom: 4 }]}>MIN</Text>
            <DrumRollPicker key={`m-${goalPickerKey}`} items={MINS_ITEMS} selectedIndex={mIdx}
              onChange={i => setGoalTime(goalHours, String(i).padStart(2, '0'))} />
          </View>
        </View>

        {divStats && divStats.athlete_count > 0 && (
          <Text style={styles.percentileHint}>
            Based on {divStats.athlete_count.toLocaleString()} athletes in {divStats.division}
          </Text>
        )}

        <View style={{ gap: 10 }}>
          {presets.map(p => {
            const selected = data.hyrox_goal_time === p.time;
            return (
              <TouchableOpacity key={p.label} style={[styles.presetCard, selected && styles.presetCardSelected]}
                onPress={() => { const [h, m] = p.time.split(':'); setGoalTime(h, m); setGoalPickerKey(k => k + 1); }}>
                <View>
                  <Text style={styles.presetLabel}>{p.label}</Text>
                  <Text style={styles.presetSub}>{p.percentile}</Text>
                </View>
                <Text style={styles.presetTime}>{p.time}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    );
  }

  function renderHyroxHistory() {
    return (
      <View style={styles.stepContent}>
        <Text style={styles.label}>Have you raced HYROX before?</Text>
        <TouchableOpacity style={[styles.goalCard, data.hyrox_has_raced === 'yes' && styles.goalCardSelected]}
          onPress={() => autoAdvance({ hyrox_has_raced: 'yes' })}>
          <View style={styles.goalCardInner}>
            <Feather name="check-circle" size={28} color={Colors.accent} />
            <Text style={[styles.goalCardTitle, data.hyrox_has_raced === 'yes' && styles.goalCardTitleSelected]}>Yes — search my results</Text>
            <Text style={styles.goalCardSub}>Import your official race splits for a more accurate profile</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.goalCard, data.hyrox_has_raced === 'no' && styles.goalCardSelected]}
          onPress={() => autoAdvance({ hyrox_has_raced: 'no' })}>
          <View style={styles.goalCardInner}>
            <Feather name="star" size={28} color={Colors.accent} />
            <Text style={[styles.goalCardTitle, data.hyrox_has_raced === 'no' && styles.goalCardTitleSelected]}>No — I'm a first-timer</Text>
            <Text style={styles.goalCardSub}>We'll build your profile from confidence ratings</Text>
          </View>
        </TouchableOpacity>
      </View>
    );
  }

  function renderHyroxResultsImport() {
    const RUN_KEYS = ['run_1','run_2','run_3','run_4','run_5','run_6','run_7','run_8'];
    if (showManualSplits) {
      return (
        <View style={[styles.stepContent, { flex: 1 }]}>
          <Text style={styles.label}>Enter your splits manually</Text>
          <ScrollView showsVerticalScrollIndicator={false}>
            <Text style={[styles.sectionHeader, { marginTop: 4 }]}>FINISH TIME</Text>
            <View style={styles.splitRow}>
              <Text style={styles.splitLabel}>Total Time</Text>
              <TextInput style={styles.splitInput} value={manualSplits['finish_time'] ?? ''} onChangeText={v => setManualSplits(prev => ({ ...prev, finish_time: v }))}
                placeholder="1:15:00" placeholderTextColor={Colors.textSecondary} keyboardType="numbers-and-punctuation" />
            </View>
            <Text style={[styles.sectionHeader, { marginTop: 12 }]}>RUN SPLITS</Text>
            {RUN_KEYS.map((k, i) => (
              <View key={k} style={styles.splitRow}>
                <Text style={styles.splitLabel}>Run {i + 1}</Text>
                <TextInput style={styles.splitInput} value={manualSplits[k] ?? ''} onChangeText={v => setManualSplits(prev => ({ ...prev, [k]: v }))}
                  placeholder="4:30" placeholderTextColor={Colors.textSecondary} keyboardType="numbers-and-punctuation" />
              </View>
            ))}
            <Text style={[styles.sectionHeader, { marginTop: 12 }]}>STATION SPLITS</Text>
            {STATION_KEYS.map(k => (
              <View key={k} style={styles.splitRow}>
                <Text style={styles.splitLabel}>{STATION_LABELS[k]}</Text>
                <TextInput style={styles.splitInput} value={manualSplits[k] ?? ''} onChangeText={v => setManualSplits(prev => ({ ...prev, [k]: v }))}
                  placeholder="0:00" placeholderTextColor={Colors.textSecondary} keyboardType="numbers-and-punctuation" />
              </View>
            ))}
            <Text style={[styles.sectionHeader, { marginTop: 12 }]}>ROXZONE</Text>
            <View style={styles.splitRow}>
              <Text style={styles.splitLabel}>Transitions</Text>
              <TextInput style={styles.splitInput} value={manualSplits['roxzone'] ?? ''} onChangeText={v => setManualSplits(prev => ({ ...prev, roxzone: v }))}
                placeholder="2:00" placeholderTextColor={Colors.textSecondary} keyboardType="numbers-and-punctuation" />
            </View>
            <TouchableOpacity style={[styles.continueBtn, { marginTop: 20, marginBottom: 8 }]} onPress={useManualSplits}>
              <Text style={styles.continueBtnText}>Use These Times</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      );
    }

    return (
      <View style={[styles.stepContent, { flex: 1 }]}>
        <Text style={styles.label}>Import from HYROX</Text>
        <Text style={styles.sublabel}>Search your official race results</Text>
        <View style={styles.searchRow}>
          <TextInput style={[styles.textInput, { flex: 1 }]} value={searchQuery}
            onChangeText={setSearchQuery} placeholder={data.first_name || 'Your name'}
            placeholderTextColor={Colors.textSecondary} returnKeyType="search" onSubmitEditing={doSearch}
            selectionColor={Colors.accent} autoFocus />
          <TouchableOpacity style={styles.searchBtn} onPress={doSearch}>
            {searchLoading ? <ActivityIndicator color={Colors.background} size="small" /> : <Feather name="search" size={18} color={Colors.background} />}
          </TouchableOpacity>
        </View>
        <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
          {searchResults.map(athlete => (
            <TouchableOpacity key={`${athlete.athlete_name}-${athlete.location}`} style={styles.option} onPress={() => selectAthlete(athlete)}>
              <Text style={styles.optionText}>{athlete.athlete_name}</Text>
              <Text style={styles.sublabel}>{athlete.location} · {athlete.division} · {athlete.finish_time}</Text>
            </TouchableOpacity>
          ))}
          {racesLoading && <ActivityIndicator color={Colors.accent} style={{ marginTop: 16 }} />}
          {athleteRaces.map(race => (
            <View key={race.id} style={styles.raceResultCard}>
              <Text style={styles.raceResultName}>{race.event_name}</Text>
              <Text style={styles.raceResultMeta}>{race.division} · {race.date} · {race.finish_time}</Text>
              <TouchableOpacity style={[styles.continueBtn, { marginTop: 8 }]} onPress={() => useRaceResult(race)}>
                <Text style={styles.continueBtnText}>Use These Times</Text>
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
        <View style={{ gap: 8, paddingTop: 8 }}>
          <TouchableOpacity style={styles.secondaryBtn} onPress={() => setShowManualSplits(true)}>
            <Text style={styles.secondaryBtnText}>Enter manually</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.skipBtn} onPress={skipResultsImport}>
            <Text style={styles.skipText}>Skip — use estimates instead</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  function renderHyroxStationConf() {
    const weaknesses = data.hyrox_weaknesses ?? [];
    const STATION_DESCRIPTIONS: Record<string, string> = {
      ski_erg: 'Technique-heavy aerobic pull — pacing strategy matters',
      sled_push: 'Leg drive and power output under load',
      sled_pull: 'Grip and pulling endurance over 200m',
      burpee_broad_jumps: 'Explosive jumps over 80m — legs are already toast',
      row_erg: 'Aerobic capacity — technique degrades when fatigued',
      farmers_carry: 'Grip and gait under heavy load for 200m',
      sandbag_lunges: 'Leg endurance with load — 100m of burn',
      wall_balls: '100 reps at the end when you\'re already spent',
    };

    function toggleWeakness(station: string) {
      setData(prev => {
        const arr = prev.hyrox_weaknesses ?? [];
        const next = arr.includes(station) ? arr.filter(s => s !== station) : [...arr, station];
        return { ...prev, hyrox_weaknesses: next };
      });
    }

    return (
      <View style={[styles.stepContent, { flex: 1 }]}>
        <Text style={styles.label}>Which stations do you struggle with most?</Text>
        <Text style={styles.sublabel}>Select all that apply — we'll target these from day one</Text>
        <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1 }}>
          <View style={{ gap: 8 }}>
            {STATION_KEYS.map(k => {
              const selected = weaknesses.includes(k);
              return (
                <TouchableOpacity key={k} style={[styles.weaknessCard, selected && styles.weaknessCardSelected]}
                  onPress={() => toggleWeakness(k)}>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.weaknessName, selected && styles.weaknessNameSelected]}>{STATION_LABELS[k]}</Text>
                      <Text style={styles.weaknessDesc}>{STATION_DESCRIPTIONS[k]}</Text>
                    </View>
                    {selected && <Feather name="check" size={16} color="#e8ff47" style={{ marginTop: 2, marginLeft: 8 }} />}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
          <TouchableOpacity style={[styles.skipBtn, { marginTop: 16 }]}
            onPress={() => autoAdvance({ hyrox_weaknesses: [] })}>
            <Text style={styles.skipText}>Not sure yet</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }

  function renderHyroxRadarChart() {
    const hasRealSplits = (data.race_data_source === 'api' || data.race_data_source === 'manual') && data.station_splits !== null;
    const weaknesses = data.hyrox_weaknesses ?? [];
    const day1 = hasRealSplits ? splitsToRadarValues(data.station_splits!) : weaknessesToRadarValues(weaknesses);
    const firstWeakness = weaknesses[0];

    return (
      <View style={[styles.stepContent, { alignItems: 'center' }]}>
        <Text style={[styles.label, { textAlign: 'center' }]}>Day 1 — Your Station Profile</Text>
        <Text style={[styles.sublabel, { textAlign: 'center', marginBottom: 16 }]}>
          {hasRealSplits ? 'Based on your race data' : 'Based on your station selections'}
        </Text>
        <RadarChart day1={day1} size={280} />
        <View style={styles.coachingCard}>
          <Text style={styles.coachingText}>
            {hasRealSplits
              ? 'Your station shape comes from real race splits. We\'ll target your weakest stations from day one.'
              : firstWeakness
                ? `Your ${STATION_LABELS[firstWeakness]} is your biggest opportunity. We're targeting it from day one.`
                : 'Assessment week will identify your station profile.'}
          </Text>
        </View>
      </View>
    );
  }

  function renderHyroxRaceDay() {
    const hasRealSplits = (data.race_data_source === 'api' || data.race_data_source === 'manual') && data.station_splits !== null;
    const weaknesses = data.hyrox_weaknesses ?? [];
    const day1 = hasRealSplits ? splitsToRadarValues(data.station_splits!) : weaknessesToRadarValues(weaknesses);
    const [h, m] = (data.hyrox_goal_time || '1:30').split(':').map(Number);
    const goalMinsTotal = (h || 0) * 60 + (m || 0);
    const raceDay = getDivisionBenchmarks(data.hyrox_division || 'men-open', goalMinsTotal);

    const prevTimeSecs = data.previous_race_time ? parseTimeToSecs(data.previous_race_time) : 0;
    const goalTimeSecs = parseTimeToSecs(data.hyrox_goal_time || '1:30');
    const prevTimeMins = prevTimeSecs / 60;
    const goalTimeMins = goalTimeSecs / 60;
    const readiness = prevTimeSecs > 0 ? Math.min(99, Math.round((goalTimeMins / prevTimeMins) * 100)) : 0;
    const improvementMins = prevTimeSecs > 0 ? Math.round(prevTimeMins - goalTimeMins) : 0;

    // Run splits are always MM:SS — bypass parseTimeToSecs H:MM ambiguity logic
    const parseMMSS = (t: string): number => {
      const p = t.split(':').map(Number);
      return p.length === 2 ? p[0] * 60 + p[1] : 0;
    };
    const formatFinishTime = (mmss: string): string => {
      const totalMins = parseMMSS(mmss) / 60;
      if (totalMins < 60) return mmss;
      const h = Math.floor(totalMins / 60);
      const m = Math.round(totalMins % 60);
      return `${h}:${String(m).padStart(2, '0')}`;
    };
    const RUN_KEYS = ['run1','run2','run3','run4','run5','run6','run7','run8'];
    const totalRunSecs = data.run_splits
      ? RUN_KEYS.reduce((sum, k) => {
          const raw = data.run_splits![k];
          const secs = raw ? parseMMSS(raw) : 0;
          console.log(`[runSplit] ${k}: "${raw}" → ${secs}s`);
          return sum + secs;
        }, 0)
      : 0;
    const roxzoneSecs = data.roxzone_time ? parseMMSS(data.roxzone_time) : 0;
    console.log(`[runSplit] roxzone: "${data.roxzone_time}" → ${roxzoneSecs}s | total: ${totalRunSecs + roxzoneSecs}s`);
    const totalRunningTimeSecs = totalRunSecs + roxzoneSecs;

    return (
      <View style={[styles.stepContent, { alignItems: 'center' }]}>
        <Text style={[styles.label, { textAlign: 'center' }]}>Race Day</Text>
        <Text style={[styles.sublabel, { textAlign: 'center' }]}>Your projected station profile with training</Text>

        {readiness > 0 && (
          <View style={{ alignItems: 'center', marginTop: 4 }}>
            <Text style={{ color: Colors.accent, fontSize: 52, fontWeight: '700', letterSpacing: -2, lineHeight: 56 }}>{readiness}%</Text>
            <Text style={{ color: Colors.textSecondary, fontSize: 12, letterSpacing: 1 }}>RACE READINESS</Text>
          </View>
        )}

        {data.previous_race_time && data.hyrox_goal_time && (
          <View style={{ flexDirection: 'row', gap: 10, alignSelf: 'stretch' }}>
            <View style={{ flex: 1, backgroundColor: Colors.nested, borderRadius: 12, padding: 14, alignItems: 'center' }}>
              <Text style={{ color: Colors.textSecondary, fontSize: 10, fontWeight: '600', letterSpacing: 1.5, marginBottom: 4 }}>YOU NOW</Text>
              <Text style={{ color: Colors.textSecondary, fontSize: 26, fontWeight: '700' }}>{formatFinishTime(data.previous_race_time)}</Text>
            </View>
            <View style={{ flex: 1, backgroundColor: Colors.card, borderRadius: 12, padding: 14, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(232,255,71,0.3)' }}>
              <Text style={{ color: Colors.accent, fontSize: 10, fontWeight: '600', letterSpacing: 1.5, marginBottom: 4 }}>WITH TRAINING</Text>
              <Text style={{ color: Colors.accent, fontSize: 26, fontWeight: '700' }}>{data.hyrox_goal_time}</Text>
            </View>
          </View>
        )}

        {improvementMins > 0 && (
          <Text style={{ color: Colors.textSecondary, fontSize: 13, textAlign: 'center' }}>
            {improvementMins} minute{improvementMins !== 1 ? 's' : ''} to find through training
          </Text>
        )}

        {data.run_splits && totalRunningTimeSecs > 0 && (
          <View style={{ alignItems: 'center', gap: 2 }}>
            <Text style={{ color: Colors.textSecondary, fontSize: 20, fontWeight: '700' }}>{secsToMMSS(Math.round(totalRunningTimeSecs / 8.7))}</Text>
            <Text style={{ color: Colors.textSecondary, fontSize: 10, letterSpacing: 1.5, fontWeight: '600' }}>AVG 1K PACE</Text>
          </View>
        )}

        <View style={{ marginTop: -40 }}>
          <RadarChart day1={day1} raceDay={raceDay} size={260} />
        </View>

        <View style={[styles.coachingCard, { alignSelf: 'stretch', marginTop: -20 }]}>
          <Text style={styles.coachingText}>{(() => {
            const splits = data.station_splits;
            if (!splits) return 'With targeted training across all 8 stations, every weakness becomes a strength.';
            const STATION_NAMES: Record<string, string> = {
              ski_erg: 'Ski Erg', sled_push: 'Sled Push', sled_pull: 'Sled Pull',
              burpee_broad_jump: 'Burpee Broad Jumps', burpee_broad_jumps: 'Burpee Broad Jumps',
              row_erg: 'Row Erg', farmers_carry: 'Farmers Carry',
              sandbag_lunges: 'Sandbag Lunges', wall_balls: 'Wall Balls',
            };
            const weakest = Object.entries(splits).reduce<[string, number]>(
              ([wk, wt], [k, v]) => { const s = parseMMSS(v); return s > wt ? [k, s] : [wk, wt]; },
              ['', 0]
            );
            const name = STATION_NAMES[weakest[0]] ?? weakest[0];
            const verb = ['Wall Balls','Sandbag Lunges','Burpee Broad Jumps'].includes(name) ? 'are' : 'is';
            return `Your ${name} ${verb} your biggest opportunity. We're targeting it from day one.`;
          })()}</Text>
        </View>
      </View>
    );
  }

  function renderBackground(isHyrox: boolean) {
    const opts = isHyrox
      ? [
          { label: 'HYROX experienced', sub: 'I\'ve raced HYROX before and want to beat my time', value: 'hyrox' },
          { label: 'CrossFit / functional fitness', sub: 'I train CrossFit-style or functional workouts regularly', value: 'crossfit' },
          { label: 'Running / endurance', sub: 'My background is running, triathlon, or endurance sport', value: 'endurance' },
          { label: 'Regular gym-goer', sub: 'I train regularly but not in the categories above', value: 'gym' },
          { label: 'New to fitness', sub: 'I\'m just getting started — ease me in', value: 'beginner' },
        ]
      : [
          { label: 'CrossFit / functional fitness', sub: 'I train CrossFit-style or functional workouts regularly', value: 'crossfit' },
          { label: 'Running / endurance', sub: 'My background is running, triathlon, or endurance sport', value: 'endurance' },
          { label: 'Strength / gym training', sub: 'I primarily lift weights', value: 'gym' },
          { label: 'General / mixed', sub: 'I train regularly but not in one specific discipline', value: 'general' },
          { label: 'New to fitness', sub: 'I\'m just getting started — ease me in', value: 'beginner' },
        ];

    return (
      <View style={[styles.stepContent, { flex: 1 }]}>
        <Text style={styles.label}>What's your fitness background?</Text>
        <Text style={styles.sublabel}>So we program your plan for where you're actually starting from</Text>
        {isHyrox && (data.race_data_source === 'api' || data.race_data_source === 'manual') ? (
          <View style={styles.coachingCard}>
            <Text style={styles.coachingText}>We've noted your HYROX experience. Continuing with HYROX-experienced programming.</Text>
          </View>
        ) : (
          <View style={{ gap: 10 }}>
            {opts.map(o => (
              <TouchableOpacity key={o.value} style={[styles.descOption, data.training_background === o.value && styles.descOptionSelected]}
                onPress={() => set('training_background', o.value)}>
                <Text style={[styles.descOptionTitle, data.training_background === o.value && { color: '#e8ff47' }]}>{o.label}</Text>
                <Text style={styles.descOptionSub}>{o.sub}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>
    );
  }

  function renderAboutYou() {
    const imp = data.units === 'imperial';
    const hItems = imp ? HEIGHT_IMPERIAL_ITEMS : HEIGHT_METRIC_ITEMS;
    const wItems = imp ? WEIGHT_IMPERIAL_ITEMS : WEIGHT_METRIC_ITEMS;
    const hIdx = imp ? Math.max(0, Math.min(hItems.length-1, Math.round(data.height_cm/2.54)-54)) : Math.max(0, Math.min(hItems.length-1, Math.round(data.height_cm)-137));
    const wIdx = imp ? Math.max(0, Math.min(wItems.length-1, Math.round(data.weight_kg/0.453592)-80)) : Math.max(0, Math.min(wItems.length-1, Math.round((data.weight_kg-36)/0.5)));

    function handleDOBChange(mIdx: number, dIdx: number, yIdx: number) {
      const month = String(mIdx + 1).padStart(2, '0');
      const day = String(dIdx + 1).padStart(2, '0');
      const year = DOB_YEARS[yIdx];
      set('date_of_birth', `${year}-${month}-${day}`);
    }

    return (
      <View style={{ flex: 1, paddingHorizontal: 24, paddingVertical: 12, gap: 16 }}>
        <View>
          <Text style={styles.label}>About you.</Text>
          <Text style={styles.sublabel}>Help us personalize your experience</Text>
        </View>

        <View style={{ gap: 8 }}>
          <Text style={styles.sectionHeader}>GENDER</Text>
          {data.goal === 'hyrox' ? (
            <View style={styles.twoCardRow}>
              {[{l:'Male',v:'male'},{l:'Female',v:'female'}].map(g => (
                <TouchableOpacity key={g.v} style={[styles.halfCard, data.gender === g.v && styles.halfCardSelected]}
                  onPress={() => set('gender', g.v)}>
                  <Text style={[styles.halfCardTitle, data.gender === g.v && { color: '#e8ff47' }]}>{g.l}</Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : (
            <View style={styles.twoByTwoGrid}>
              {[{l:'Male',v:'male'},{l:'Female',v:'female'},{l:'Other',v:'other'},{l:'Skip',v:'skip'}].map(g => (
                <TouchableOpacity key={g.v} style={[styles.gridBtn, data.gender === g.v && styles.gridBtnSelected]}
                  onPress={() => set('gender', g.v)}>
                  <Text style={[styles.gridBtnText, data.gender === g.v && { color: '#e8ff47' }]}>{g.l}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        <View style={{ gap: 4 }}>
          <View style={styles.unitToggleRow}>
            <Text style={styles.sectionHeader}>HEIGHT / WEIGHT</Text>
            <View style={styles.unitToggle}>
              {(['imperial','metric'] as const).map(u => (
                <TouchableOpacity key={u} style={[styles.unitBtn, data.units === u && styles.unitBtnActive]}
                  onPress={() => set('units', u)}>
                  <Text style={[styles.unitBtnText, data.units === u && styles.unitBtnTextActive]}>{u === 'imperial' ? 'ft / lbs' : 'cm / kg'}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <DrumRollPicker key={`h-${data.units}`} items={hItems} selectedIndex={hIdx}
                onChange={idx => set('height_cm', imp ? (54+idx)*2.54 : 137+idx)} />
            </View>
            <View style={{ flex: 1 }}>
              <DrumRollPicker key={`w-${data.units}`} items={wItems} selectedIndex={wIdx}
                onChange={idx => set('weight_kg', imp ? (80+idx)*0.453592 : 36+idx*0.5)} />
            </View>
          </View>
        </View>

        <View style={{ gap: 4 }}>
          <Text style={styles.sectionHeader}>DATE OF BIRTH</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 3 }}>
              <DrumRollPicker items={DOB_MONTHS} selectedIndex={dobMonthIdx}
                onChange={i => { setDobMonthIdx(i); handleDOBChange(i, dobDayIdx, dobYearIdx); }} />
            </View>
            <View style={{ flex: 2 }}>
              <DrumRollPicker items={DOB_DAYS} selectedIndex={dobDayIdx}
                onChange={i => { setDobDayIdx(i); handleDOBChange(dobMonthIdx, i, dobYearIdx); }} />
            </View>
            <View style={{ flex: 3 }}>
              <DrumRollPicker items={DOB_YEARS} selectedIndex={dobYearIdx}
                onChange={i => { setDobYearIdx(i); handleDOBChange(dobMonthIdx, dobDayIdx, i); }} />
            </View>
          </View>
        </View>
      </View>
    );
  }

  function renderGfPrimaryGoals() {
    const opts = [
      { label: 'Build muscle', value: 'build_muscle' },
      { label: 'Lose weight', value: 'lose_weight' },
      { label: 'Look better', value: 'look_better' },
      { label: 'Run faster', value: 'run_faster' },
      { label: 'Get stronger', value: 'get_stronger' },
      { label: 'All of the above', value: 'all' },
    ];
    return (
      <View style={styles.stepContent}>
        <Text style={styles.label}>What is your primary goal?</Text>
        <Text style={styles.sublabel}>Select all that apply</Text>
        <View style={{ gap: 10 }}>
          {opts.map(o => {
            const selected = data.primary_goals.includes(o.value);
            return (
              <TouchableOpacity key={o.value} style={[styles.option, selected && styles.optionSelected]} onPress={() => togglePrimaryGoal(o.value)}>
                <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{o.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    );
  }

  function renderGfBodyFat() {
    return (
      <View style={styles.stepContent}>
        <Text style={styles.label}>Do you know your body fat percentage?</Text>
        <Text style={styles.sublabel}>Helps us set accurate composition targets</Text>
        <View style={{ gap: 10 }}>
          {['Under 15%','15–20%','20–25%','25–30%','30%+','Not sure'].map(v => (
            <TouchableOpacity key={v} style={[styles.option, data.body_fat === v && styles.optionSelected]} onPress={() => set('body_fat', v)}>
              <Text style={[styles.optionText, data.body_fat === v && styles.optionTextSelected]}>{v}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    );
  }

  function renderInjuries() {
    return (
      <View style={styles.stepContent}>
        <Text style={styles.label}>Any injuries or limitations?</Text>
        <Text style={styles.sublabel}>So we can modify workouts and protect problem areas</Text>

        <TouchableOpacity style={[styles.goalCard, data.has_injuries === false && styles.goalCardSelected]}
          onPress={() => autoAdvance({ has_injuries: false, injury_notes: '' })}>
          <View style={styles.goalCardInner}>
            <Text style={[styles.goalCardTitle, data.has_injuries === false && styles.goalCardTitleSelected]}>No injuries</Text>
            <Text style={styles.goalCardSub}>I'm good to train without restrictions</Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity style={[styles.goalCard, data.has_injuries === true && styles.goalCardSelected]}
          onPress={() => set('has_injuries', true)}>
          <View style={styles.goalCardInner}>
            <Text style={[styles.goalCardTitle, data.has_injuries === true && styles.goalCardTitleSelected]}>Yes — I have something to flag</Text>
            <Text style={styles.goalCardSub}>We'll modify workouts and add mobility work</Text>
          </View>
        </TouchableOpacity>

        {data.has_injuries && (
          <>
            <TextInput style={[styles.textInput, { height: 100, textAlignVertical: 'top', paddingTop: 12 }]}
              value={data.injury_notes} onChangeText={v => set('injury_notes', v)} multiline autoFocus
              placeholder="e.g. Lower back pain when lifting heavy, recovering from ankle sprain..."
              placeholderTextColor={Colors.textSecondary} selectionColor={Colors.accent} />
            <View style={styles.coachingCard}>
              <Text style={styles.coachingText}>We'll use this to suggest exercise modifications, adjust workout intensity, and include mobility work for problem areas.</Text>
            </View>
          </>
        )}
      </View>
    );
  }

  function renderTrainingSetup() {
    const envOpts = [
      { label: 'Full Gym Access', sub: 'Commercial gym with HYROX equipment', value: 'full', icon: 'layers' as const },
      { label: 'Home Gym', sub: 'Some equipment at home', value: 'home', icon: 'home' as const },
      { label: 'Minimal Equipment', sub: 'Bodyweight + running only', value: 'minimal', icon: 'user' as const },
    ];
    const equipmentItems = [
      'Ski Erg', 'Row Erg', 'Sled', 'Dumbbells', 'Barbell & Plates',
      'Kettlebells', 'Sandbags', 'Wall Balls', 'Assault / Echo Bike', 'Pull-up Bar',
    ];
    return (
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 12, paddingBottom: 16 }}>
        <Text style={styles.label}>Quick Setup</Text>
        <Text style={styles.sublabel}>We'll adapt workouts to your situation</Text>
        <View style={{ gap: 10 }}>
          {envOpts.map(o => (
            <TouchableOpacity key={o.value} style={[styles.descOption, data.equipment_access === o.value && styles.descOptionSelected]}
              onPress={() => set('equipment_access', o.value)}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <Feather name={o.icon} size={20} color={Colors.accent} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.descOptionTitle, data.equipment_access === o.value && { color: '#e8ff47' }]}>{o.label}</Text>
                  <Text style={styles.descOptionSub}>{o.sub}</Text>
                </View>
              </View>
            </TouchableOpacity>
          ))}
        </View>
        {data.equipment_access !== '' && data.equipment_access !== 'full' && (
          <View style={{ gap: 8, marginTop: 4 }}>
            <Text style={styles.sectionHeader}>WHAT DO YOU HAVE ACCESS TO?</Text>
            {equipmentItems.map(item => {
              const selected = data.hyrox_equipment_list.includes(item);
              return (
                <TouchableOpacity key={item} style={[styles.weaknessCard, selected && styles.weaknessCardSelected]}
                  onPress={() => toggleEquipment(item)}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Text style={[styles.weaknessName, selected && styles.weaknessNameSelected, { flex: 1 }]}>{item}</Text>
                    {selected && <Feather name="check" size={16} color="#e8ff47" />}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </ScrollView>
    );
  }

  function renderGfEquipment() {
    const opts = [
      { label: 'Full gym', sub: 'Barbells, dumbbells, machines, pull-up bar', value: 'full', icon: 'layers' as const },
      { label: 'Home setup', sub: 'Some equipment at home', value: 'home', icon: 'home' as const },
      { label: 'No equipment', sub: 'Bodyweight and running only', value: 'none', icon: 'user' as const },
    ];
    return (
      <View style={styles.stepContent}>
        <Text style={styles.label}>What equipment do you have access to?</Text>
        <View style={{ gap: 10 }}>
          {opts.map(o => (
            <TouchableOpacity key={o.value} style={[styles.descOption, data.equipment_access === o.value && styles.descOptionSelected]}
              onPress={() => set('equipment_access', o.value)}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <Feather name={o.icon} size={20} color={Colors.accent} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.descOptionTitle, data.equipment_access === o.value && { color: '#e8ff47' }]}>{o.label}</Text>
                  <Text style={styles.descOptionSub}>{o.sub}</Text>
                </View>
              </View>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    );
  }

  function renderTrainingDays() {
    const count = data.training_days.length;
    return (
      <View style={styles.stepContent}>
        <Text style={styles.label}>Training Availability</Text>
        <Text style={styles.sublabel}>Select the days you can train each week</Text>
        <View style={styles.dayGrid}>
          {WEEK_DAYS.map((day, i) => {
            const selected = data.training_days.includes(day.charAt(0).toUpperCase() + day.slice(1));
            return (
              <TouchableOpacity key={day} style={[styles.dayBtn, selected && styles.dayBtnSelected]} onPress={() => toggleTrainingDay(day)}>
                <Text style={[styles.dayBtnText, selected && styles.dayBtnTextSelected]}>{WEEK_LABELS[i]}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        {count > 0 && (
          <View style={styles.daysSummaryCard}>
            <Text style={styles.daysSummaryText}>{count} days selected: {data.training_days.map(d => d.charAt(0).toUpperCase() + d.slice(1, 3)).join(', ')}</Text>
          </View>
        )}
        {count < 2 && count > 0 && (
          <Text style={[styles.sublabel, { color: Colors.red }]}>Select at least 2 days to continue</Text>
        )}
        {count === 7 ? (
          <View style={[styles.coachingCard, { borderLeftWidth: 3, borderLeftColor: Colors.red, borderColor: 'rgba(255,59,59,0.2)' }]}>
            <Text style={[styles.coachingText, { color: Colors.red }]}>Training 7 days a week leads to overtraining and injury. We recommend at least 1–2 rest days per week for recovery.</Text>
          </View>
        ) : (
          <View style={styles.coachingCard}>
            <Text style={styles.coachingText}>Recommended: 3–5 days — Most athletes see best results with 3–5 training days per week, allowing for adequate recovery.</Text>
          </View>
        )}
      </View>
    );
  }

  function renderSessionDetails() {
    return (
      <View style={styles.stepContent}>
        <Text style={styles.label}>When are you available to train?</Text>
        <View style={{ gap: 10 }}>
          {[
            { label: 'Mornings (AM)', sub: 'Early sessions, before work or school', value: 'am' },
            { label: 'Evenings (PM)', sub: 'After work or later in the day', value: 'pm' },
            { label: 'Both', sub: 'I can do AM and PM sessions', value: 'both' },
          ].map(o => (
            <TouchableOpacity key={o.value} style={[styles.descOption, data.training_availability === o.value && styles.descOptionSelected]}
              onPress={() => { set('training_availability', o.value); if (o.value !== 'both') { set('doubles_eligible', null); set('doubles_days', []); } }}>
              <Text style={[styles.descOptionTitle, data.training_availability === o.value && { color: '#e8ff47' }]}>{o.label}</Text>
              <Text style={styles.descOptionSub}>{o.sub}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={[styles.sectionHeader, { marginTop: 16 }]}>SESSION LENGTH</Text>
        <View style={{ gap: 10 }}>
          {[{ label: 'About 1 hour', value: '60' }, { label: 'About 1.5–2 hours', value: '90' }].map(o => (
            <TouchableOpacity key={o.value} style={[styles.option, data.session_length === o.value && styles.optionSelected]}
              onPress={() => set('session_length', o.value)}>
              <Text style={[styles.optionText, data.session_length === o.value && styles.optionTextSelected]}>{o.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {data.training_availability === 'both' && (
          <View style={styles.doublesCard}>
            <Text style={styles.doublesQuestion}>On training days, can you train in BOTH the AM and PM on the same day?</Text>
            <View style={{ gap: 8, marginTop: 10 }}>
              {[
                { label: 'Yes — I can do AM + PM sessions', value: true },
                { label: 'No — I alternate, not both same day', value: false },
              ].map(o => (
                <TouchableOpacity key={String(o.value)} style={[styles.option, data.doubles_eligible === o.value && styles.optionSelected]}
                  onPress={() => {
                    set('doubles_eligible', o.value);
                    if (!o.value) set('doubles_days', []);
                  }}>
                  <Text style={[styles.optionText, data.doubles_eligible === o.value && styles.optionTextSelected]}>{o.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {data.doubles_eligible === true && (
              <View style={{ marginTop: 16 }}>
                <Text style={styles.sectionHeader}>WHICH DAYS CAN YOU DOUBLE?</Text>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  {data.training_days.map(day => {
                    const idx = WEEK_DAYS.indexOf(day);
                    const label = idx >= 0 ? WEEK_LABELS[idx] : day.slice(0, 1).toUpperCase();
                    const selected = data.doubles_days.includes(day);
                    return (
                      <TouchableOpacity
                        key={day}
                        style={[styles.dayBtn, selected && styles.dayBtnSelected]}
                        onPress={() => {
                          const next = selected
                            ? data.doubles_days.filter(d => d !== day)
                            : [...data.doubles_days, day];
                          set('doubles_days', next);
                        }}>
                        <Text style={[styles.dayBtnText, selected && styles.dayBtnTextSelected]}>{label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            )}
          </View>
        )}
      </View>
    );
  }

  function renderWearable() {
    const opts = [
      { label: 'Whoop', sub: 'Direct API connection', value: 'whoop', icon: 'activity' as const },
      { label: 'Apple Watch', sub: 'Via Apple Health', value: 'apple-watch', icon: 'watch' as const },
      { label: 'Amazfit / Zepp', sub: 'Via Apple Health or Google Fit', value: 'amazfit', icon: 'watch' as const },
      { label: 'Polar', sub: 'Via Apple Health or Google Fit', value: 'polar', icon: 'activity' as const },
      { label: 'Other', sub: 'Via Apple Health or Google Fit', value: 'other', icon: 'bluetooth' as const },
      { label: 'None', sub: "We'll use your session feedback", value: 'none', icon: 'x-circle' as const },
    ];
    const selectedLabels = data.wearable
      .filter(v => v !== 'none')
      .map(v => opts.find(o => o.value === v)?.label)
      .filter(Boolean)
      .join(' + ');
    return (
      <View style={[styles.stepContent, { flex: 1 }]}>
        <Text style={styles.label}>What wearable do you use?</Text>
        <Text style={styles.sublabel}>Select all that apply — connects your recovery data to your program</Text>
        <ScrollView showsVerticalScrollIndicator={false}>
          <View style={{ gap: 10 }}>
            {opts.map(o => {
              const selected = data.wearable.includes(o.value);
              return (
                <TouchableOpacity key={o.value} style={[styles.descOption, selected && styles.descOptionSelected]}
                  onPress={() => toggleWearable(o.value)}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <Feather name={o.icon} size={18} color={Colors.accent} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.descOptionTitle, selected && { color: '#e8ff47' }]}>{o.label}</Text>
                      <Text style={styles.descOptionSub}>{o.sub}</Text>
                    </View>
                    {selected && <Feather name="check" size={16} color="#e8ff47" />}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
          {selectedLabels.length > 0 && (
            <View style={[styles.coachingCard, { marginTop: 12 }]}>
              <Text style={styles.coachingText}>We'll use your {selectedLabels} data to calculate your Peak Score each morning and adjust your program automatically.</Text>
            </View>
          )}
        </ScrollView>
      </View>
    );
  }

  function renderReferral() {
    return (
      <View style={styles.stepContent}>
        <Text style={styles.label}>How did you hear about Peak 65?</Text>
        <Text style={styles.sublabel}>Help us understand how athletes like you find us</Text>
        <View style={{ gap: 10 }}>
          {['Instagram','TikTok','Friend or Family','App Store','YouTube','Other'].map(v => (
            <TouchableOpacity key={v} style={[styles.option, data.referral_source === v && styles.optionSelected]}
              onPress={() => set('referral_source', v)}>
              <Text style={[styles.optionText, data.referral_source === v && styles.optionTextSelected]}>{v}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    );
  }

  function renderGfClosing() {
    const isBodyComp = data.primary_goals.some(g => ['lose_weight','look_better','all','build_muscle'].includes(g));
    const isPerf = data.primary_goals.some(g => ['run_faster','get_stronger'].includes(g));
    const bg = data.training_background;
    const isBlank = bg === 'beginner' || bg === '';

    const milestones = isBodyComp ? [
      { mo: 'Month 1', text: 'Build your training foundation. Establish your strength baseline. Start moving daily.' },
      { mo: 'Month 3', text: 'Visible strength gains. Improved cardiovascular endurance. Body composition shifting.' },
      { mo: 'Month 6', text: 'The body you\'ve been building toward. Stronger, leaner, more capable.' },
    ] : isPerf ? [
      { mo: 'Month 1', text: 'Establish your threshold zones. Run your first structured intervals. Begin progressive loading.' },
      { mo: 'Month 3', text: 'Threshold pace improving. Strength numbers climbing. Feeling athletic in daily life.' },
      { mo: 'Month 6', text: 'PR ready. The version of you that runs faster and lifts heavier than six months ago.' },
    ] : isBlank ? [
      { mo: 'Month 1', text: 'Learn the movements. Build the habit. Establish what your body can do.' },
      { mo: 'Month 3', text: 'All major patterns established. First real fitness gains. Building momentum.' },
      { mo: 'Month 6', text: 'Unrecognizable from Day 1. This is what six months of structure does.' },
    ] : [
      { mo: 'Month 1', text: 'Build your aerobic base. Move consistently. Protect your joints while building strength.' },
      { mo: 'Month 3', text: 'Consistent Zone 2 base. Functional strength for everyday life. Energy levels stable.' },
      { mo: 'Month 6', text: 'A sustainable training life. Strong, healthy, and still going.' },
    ];

    const coaching = deriveWhatMattersMost(data.primary_goals) === 'aesthetics'
      ? 'Peak 65 programs strength and conditioning together. Looking better is a byproduct of training smarter.'
      : 'Peak 65 programs performance first. The aesthetics follow the fitness.';

    return (
      <View style={styles.stepContent}>
        <Text style={styles.label}>Here's what we're building.</Text>
        <View style={{ gap: 12 }}>
          {milestones.map(m => (
            <View key={m.mo} style={styles.milestoneCard}>
              <Text style={styles.milestoneMonth}>{m.mo}</Text>
              <Text style={styles.milestoneText}>{m.text}</Text>
            </View>
          ))}
        </View>
        <View style={styles.coachingCard}>
          <Text style={styles.coachingText}>{coaching}</Text>
        </View>
      </View>
    );
  }

  function renderOnboardingSummary() {
    const isHyrox = data.goal === 'hyrox';
    return (
      <View style={styles.stepContent}>
        {isHyrox ? (
          <>
            <Text style={styles.label}>
              {data.race_event_city ? `You're training for ${data.race_event_city}.` : 'Your program is ready to build.'}
            </Text>
            {data.weeks_to_race != null && (
              <Text style={styles.summaryHighlight}><Text style={{ color: '#e8ff47' }}>{data.weeks_to_race} weeks</Text>. Your program starts now.</Text>
            )}
          </>
        ) : (
          <Text style={styles.label}>Your program is ready to build{data.first_name ? `, ${data.first_name}` : ''}.</Text>
        )}
        <View style={{ gap: 10 }}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Training days</Text>
            <Text style={styles.summaryValue}>{data.training_days_count} days / week</Text>
          </View>
          {isHyrox && data.hyrox_division && (
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Division</Text>
              <Text style={styles.summaryValue}>{data.hyrox_division.replace('-',' ').replace(/\b\w/g,c=>c.toUpperCase())}</Text>
            </View>
          )}
          {isHyrox && data.hyrox_goal_time && (
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Goal time</Text>
              <Text style={styles.summaryValue}>{data.hyrox_goal_time}</Text>
            </View>
          )}
          {!isHyrox && data.primary_goals.length > 0 && (
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Focus</Text>
              <Text style={styles.summaryValue}>{data.primary_goals[0].replace('_',' ')}</Text>
            </View>
          )}
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Session length</Text>
            <Text style={styles.summaryValue}>{data.session_length ? `${data.session_length} min` : '—'}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Equipment</Text>
            <Text style={styles.summaryValue}>{data.equipment_access || '—'}</Text>
          </View>
        </View>
      </View>
    );
  }

  function renderCurrentStep() {
    switch (currentKey) {
      case 'goal':              return renderGoal();
      case 'hyroxRace':         return renderHyroxRace();
      case 'hyroxFormat':       return renderHyroxFormat();
      case 'hyroxGoalTime':     return renderHyroxGoalTime();
      case 'hyroxHistory':      return renderHyroxHistory();
      case 'hyroxResultsImport':return renderHyroxResultsImport();
      case 'hyroxStationConf':  return renderHyroxStationConf();
      case 'hyroxRadarChart':   return renderHyroxRadarChart();
      case 'hyroxRaceDay':      return renderHyroxRaceDay();
      case 'hyroxBackground':   return renderBackground(true);
      case 'gfBackground':      return renderBackground(false);
      case 'gfPrimaryGoals':    return renderGfPrimaryGoals();
      case 'gfBodyFat':         return renderGfBodyFat();
      case 'aboutYou':          return renderAboutYou();
      case 'injuries':          return renderInjuries();
      case 'trainingSetup':     return renderTrainingSetup();
      case 'gfEquipment':       return renderGfEquipment();
      case 'trainingDays':      return renderTrainingDays();
      case 'sessionDetails':    return renderSessionDetails();
      case 'wearable':          return renderWearable();
      case 'referral':          return renderReferral();
      case 'gfClosing':         return renderGfClosing();
      case 'onboardingSummary': return renderOnboardingSummary();
      default:                  return null;
    }
  }

  function continueLabel(): string {
    if (currentKey === 'onboardingSummary') return 'Build My Plan';
    if (currentKey === 'gfClosing') return 'Build My Plan';
    if (currentKey === 'hyroxRadarChart') return 'See Your Race Day Goal';
    if (currentKey === 'hyroxRaceDay') return 'Lock In My Plan';
    return 'Continue';
  }

  const noFooterSteps: StepKey[] = ['goal', 'hyroxHistory', ...(showManualSplits ? ['hyroxResultsImport' as StepKey] : [])];
  const scrollableSteps: StepKey[] = ['hyroxRace', 'hyroxResultsImport', 'hyroxStationConf', 'wearable', 'trainingSetup'];

  // ── Closing phase renders ─────────────────────────────────────────────────────

  if (closingPhase === 'saving') {
    const savingItems = [
      'Saving your profile',
      'Setting up your coaching system',
      'Preparing your assessment week',
      'Almost ready...',
    ];
    return (
      <SafeAreaView style={styles.container} edges={['top','bottom']}>
        <Text style={styles.logo}>Peak 65</Text>
        <View style={styles.loadingBody}>
          <Text style={styles.loadingTitle}>Setting things up{data.first_name ? `, ${data.first_name}` : ''}.</Text>
          <Text style={styles.loadingSubtext}>This takes a few seconds.</Text>
          <View style={styles.checklistContainer}>
            {savingItems.map((item, i) => {
              const done = i < checklistStep;
              const active = i === checklistStep;
              return (
                <View key={i} style={styles.checklistRow}>
                  {done ? (
                    <Feather name="check" size={16} color={Colors.accent} />
                  ) : active ? (
                    <ActivityIndicator size="small" color={Colors.accent} />
                  ) : (
                    <View style={styles.checklistDot} />
                  )}
                  <Text style={[styles.checklistText, done && { color: Colors.accent }, active && { color: Colors.textPrimary }]}>{item}</Text>
                </View>
              );
            })}
          </View>
          <View style={[styles.coachingCard, { marginTop: 32 }]}>
            <Text style={[styles.coachingText, { textAlign: 'center' }]}>{COACHING_CARDS[cardIdx]}</Text>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (closingPhase === 'push') {
    return (
      <SafeAreaView style={styles.container} edges={['top','bottom']}>
        <Text style={styles.logo}>Peak 65</Text>
        <View style={styles.loadingBody}>
          <View style={styles.notifPreview}>
            <Feather name="bell" size={24} color={Colors.accent} />
            <Text style={styles.notifPreviewText}>Peak 65 — Today's workout is waiting for you</Text>
          </View>
          <Text style={[styles.loadingTitle, { marginTop: 24 }]}>You're 2x more likely to finish your plan with workout reminders.</Text>
          <Text style={[styles.loadingSubtext, { marginTop: 8, marginBottom: 32 }]}>Athletes who enable reminders are significantly more likely to complete their program and hit their goal time.</Text>
          <TouchableOpacity style={styles.continueBtn} onPress={async () => {
            await Notifications.requestPermissionsAsync().catch(() => {});
            setClosingPhase('assessment');
          }}>
            <Text style={styles.continueBtnText}>OK</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.skipBtn} onPress={() => setClosingPhase('assessment')}>
            <Text style={styles.skipText}>Maybe later</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (closingPhase === 'assessment') {
    const isHyrox = data.goal === 'hyrox';
    const dayOrder = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    const trainingDays = Array.isArray(data.training_days)
      ? [...data.training_days]
          .map((d: string) => d.charAt(0).toUpperCase() + d.slice(1))
          .sort((a: string, b: string) => dayOrder.indexOf(a) - dayOrder.indexOf(b))
      : [];
    const restDays = dayOrder.filter(d => !trainingDays.includes(d));

    // Build session schedule based on actual training days
    // Hard 1, Easy 1, Hard 2, Easy 2, Hard 3, Easy 3, then rest days
    const sessionTypes = isHyrox
      ? ['Run Time Trial', 'Easy Recovery', 'Ski Erg + Strength', 'Easy Recovery', 'Work Capacity AMRAP', 'Easy Recovery']
      : ['Run Time Trial', 'Easy Recovery', 'Strength Baseline', 'Easy Recovery', 'Work Capacity AMRAP', 'Easy Recovery'];

    const schedule: { day: string; session: string; isHard: boolean; isRest: boolean }[] = [];
    let sessionIndex = 0;

    for (const day of dayOrder) {
      if (restDays.includes(day)) {
        schedule.push({ day, session: 'Rest', isHard: false, isRest: true });
      } else if (sessionIndex < sessionTypes.length) {
        const session = sessionTypes[sessionIndex];
        const isHard = sessionIndex % 2 === 0;
        schedule.push({ day, session, isHard, isRest: false });
        sessionIndex++;
      } else {
        schedule.push({ day, session: 'Easy Recovery', isHard: false, isRest: false });
      }
    }

    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <Text style={styles.logo}>Peak 65</Text>
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 16, paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
        >
          {/* Header */}
          <Text style={{
            fontSize: 32,
            fontWeight: '800',
            color: '#f0ede8',
            lineHeight: 38,
            marginBottom: 8,
          }}>
            Your baseline{'\n'}starts now.
          </Text>
          <Text style={{
            fontSize: 15,
            color: '#8a877f',
            marginBottom: 32,
            lineHeight: 22,
            letterSpacing: 0.2,
          }}>
            Assess. Real data. A program built for you.
          </Text>

          {/* Hard session cards */}
          {isHyrox ? (
            <>
              {/* Hyrox Card 1 */}
              <View style={{
                backgroundColor: '#111111',
                borderRadius: 16,
                padding: 20,
                marginBottom: 12,
                borderLeftWidth: 3,
                borderLeftColor: '#e8ff47',
              }}>
                <Text style={{
                  fontSize: 11,
                  fontWeight: '700',
                  letterSpacing: 2,
                  color: '#e8ff47',
                  textTransform: 'uppercase',
                  marginBottom: 8,
                }}>Hard Session 1</Text>
                <Text style={{
                  fontSize: 22,
                  fontWeight: '800',
                  color: '#f0ede8',
                  marginBottom: 6,
                  fontFamily: 'BarlowCondensed_700Bold',
                }}>Run Time Trial</Text>
                <Text style={{
                  fontSize: 13,
                  color: '#8a877f',
                  lineHeight: 19,
                }}>Your pace + HR sets your threshold anchor. Every run in your program traces back to this moment.</Text>
              </View>

              {/* Hyrox Card 2 */}
              <View style={{
                backgroundColor: '#111111',
                borderRadius: 16,
                padding: 20,
                marginBottom: 12,
                borderLeftWidth: 3,
                borderLeftColor: '#e8ff47',
              }}>
                <Text style={{
                  fontSize: 11,
                  fontWeight: '700',
                  letterSpacing: 2,
                  color: '#e8ff47',
                  textTransform: 'uppercase',
                  marginBottom: 8,
                }}>Hard Session 2</Text>
                <Text style={{
                  fontSize: 22,
                  fontWeight: '800',
                  color: '#f0ede8',
                  marginBottom: 6,
                  fontFamily: 'BarlowCondensed_700Bold',
                }}>Ski Erg Time Trial</Text>
                <Text style={{
                  fontSize: 13,
                  color: '#8a877f',
                  lineHeight: 19,
                }}>15 min rest, then strength. One session, two baselines. Your erg splits anchor every station session from here.</Text>
              </View>

              {/* Hyrox Card 3 */}
              <View style={{
                backgroundColor: '#111111',
                borderRadius: 16,
                padding: 20,
                marginBottom: 12,
                borderLeftWidth: 3,
                borderLeftColor: '#e8ff47',
              }}>
                <Text style={{
                  fontSize: 11,
                  fontWeight: '700',
                  letterSpacing: 2,
                  color: '#e8ff47',
                  textTransform: 'uppercase',
                  marginBottom: 8,
                }}>Hard Session 3</Text>
                <Text style={{
                  fontSize: 22,
                  fontWeight: '800',
                  color: '#f0ede8',
                  marginBottom: 6,
                  fontFamily: 'BarlowCondensed_700Bold',
                }}>Work Capacity AMRAP</Text>
                <Text style={{
                  fontSize: 13,
                  color: '#8a877f',
                  lineHeight: 19,
                }}>25 minutes. Your engine, measured. Every rep tells us how your engine handles fatigue. This number changes everything that comes after.</Text>
              </View>

              {/* Hyrox Card 4 — Week 2 */}
              <View style={{
                backgroundColor: '#111111',
                borderRadius: 16,
                padding: 20,
                marginBottom: 12,
                borderLeftWidth: 3,
                borderLeftColor: '#e8ff47',
                opacity: 0.75,
              }}>
                <Text style={{
                  fontSize: 11,
                  fontWeight: '700',
                  letterSpacing: 2,
                  color: '#e8ff47',
                  textTransform: 'uppercase',
                  marginBottom: 4,
                }}>Week 2 — Hard Session 4</Text>
                <Text style={{
                  fontSize: 11,
                  color: '#8a877f',
                  marginBottom: 8,
                  fontStyle: 'italic',
                }}>Unlocks after Week 1 is complete</Text>
                <Text style={{
                  fontSize: 22,
                  fontWeight: '800',
                  color: '#f0ede8',
                  marginBottom: 6,
                  fontFamily: 'BarlowCondensed_700Bold',
                }}>Row Erg Time Trial</Text>
                <Text style={{
                  fontSize: 13,
                  color: '#8a877f',
                  lineHeight: 19,
                }}>Your full erg profile locked in. Now the AI has everything it needs.</Text>
              </View>
            </>
          ) : (
            <>
              {/* GF Card 1 */}
              <View style={{
                backgroundColor: '#111111',
                borderRadius: 16,
                padding: 20,
                marginBottom: 12,
                borderLeftWidth: 3,
                borderLeftColor: '#e8ff47',
              }}>
                <Text style={{
                  fontSize: 11,
                  fontWeight: '700',
                  letterSpacing: 2,
                  color: '#e8ff47',
                  textTransform: 'uppercase',
                  marginBottom: 8,
                }}>Hard Session 1</Text>
                <Text style={{
                  fontSize: 22,
                  fontWeight: '800',
                  color: '#f0ede8',
                  marginBottom: 6,
                  fontFamily: 'BarlowCondensed_700Bold',
                }}>Run Time Trial</Text>
                <Text style={{
                  fontSize: 13,
                  color: '#8a877f',
                  lineHeight: 19,
                }}>Your pace + HR sets every future run zone. This is the number everything builds from.</Text>
              </View>

              {/* GF Card 2 */}
              <View style={{
                backgroundColor: '#111111',
                borderRadius: 16,
                padding: 20,
                marginBottom: 12,
                borderLeftWidth: 3,
                borderLeftColor: '#e8ff47',
              }}>
                <Text style={{
                  fontSize: 11,
                  fontWeight: '700',
                  letterSpacing: 2,
                  color: '#e8ff47',
                  textTransform: 'uppercase',
                  marginBottom: 8,
                }}>Hard Session 2</Text>
                <Text style={{
                  fontSize: 22,
                  fontWeight: '800',
                  color: '#f0ede8',
                  marginBottom: 6,
                  fontFamily: 'BarlowCondensed_700Bold',
                }}>Strength Baseline</Text>
                <Text style={{
                  fontSize: 13,
                  color: '#8a877f',
                  lineHeight: 19,
                }}>5RM testing across four lifts. Every load in your program traces back to what you do here.</Text>
              </View>

              {/* GF Card 3 */}
              <View style={{
                backgroundColor: '#111111',
                borderRadius: 16,
                padding: 20,
                marginBottom: 12,
                borderLeftWidth: 3,
                borderLeftColor: '#e8ff47',
              }}>
                <Text style={{
                  fontSize: 11,
                  fontWeight: '700',
                  letterSpacing: 2,
                  color: '#e8ff47',
                  textTransform: 'uppercase',
                  marginBottom: 8,
                }}>Hard Session 3</Text>
                <Text style={{
                  fontSize: 22,
                  fontWeight: '800',
                  color: '#f0ede8',
                  marginBottom: 6,
                  fontFamily: 'BarlowCondensed_700Bold',
                }}>Work Capacity AMRAP</Text>
                <Text style={{
                  fontSize: 13,
                  color: '#8a877f',
                  lineHeight: 19,
                }}>25 minutes. Your engine, measured. Every rep tells us how your engine handles fatigue. This number changes everything that comes after.</Text>
              </View>
            </>
          )}

          {/* Closing statement */}
          <Text style={{
            fontSize: 38,
            fontWeight: '900',
            fontFamily: 'BarlowCondensed_900Black',
            color: '#e8ff47',
            textAlign: 'center',
            marginTop: 40,
            marginBottom: 16,
            lineHeight: 44,
          }}>
            Three sessions.{'\n'}Real data.{'\n'}Then we build your 65.
          </Text>
        </ScrollView>

        <View style={styles.footer}>
          <TouchableOpacity
            style={styles.continueBtn}
            onPress={() => setClosingPhase('startdate')}
          >
            <Text style={styles.continueBtnText}>I'M READY →</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (closingPhase === 'startdate') {
    const dayOrder = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    const next7: Date[] = [];
    for (let i = 1; i <= 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      next7.push(d);
    }

    const formatDate = (d: Date) => d.toISOString().split('T')[0];
    const getDayName = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'long' });
    const getDayAbbr = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short' });
    const getDateNum = (d: Date) => d.getDate();

    const isTrainingDay = (d: Date) => (data.training_days as string[]).includes(getDayName(d));
    const isSelected = (d: Date) => selectedStartDate ? formatDate(d) === formatDate(selectedStartDate) : false;

    const handleBuildProgram = async () => {
      if (!selectedStartDate) return;
      const { data: auth } = await supabase.auth.getUser();
      if (!auth?.user) return;
      const formattedDate = formatDate(selectedStartDate);
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      await supabase.from('profiles').update({
        program_start_date: formattedDate,
        timezone: tz,
      }).eq('id', auth.user.id);
      setChecklistStep(0);
      setClosingPhase('generating');
      callGenerateAssessment();
    };

    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <Text style={styles.logo}>Peak 65</Text>
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 16, paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
        >
          {/* Header */}
          <Text style={{
            fontSize: 36,
            fontWeight: '900',
            color: '#f0ede8',
            lineHeight: 42,
            marginBottom: 8,
            fontFamily: 'BarlowCondensed_700Bold',
            letterSpacing: 0.5,
          }}>
            Pick your{'\n'}Day One.
          </Text>
          <Text style={{
            fontSize: 14,
            color: '#8a877f',
            marginBottom: 32,
            lineHeight: 20,
          }}>
            The sooner you start, the smarter your program gets.
          </Text>

          {/* Date pills — full width row, 7 pills */}
          <View style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            marginBottom: 28,
          }}>
            {next7.map((date, idx) => {
              const training = isTrainingDay(date);
              const selected = isSelected(date);
              return (
                <TouchableOpacity
                  key={idx}
                  disabled={!training}
                  onPress={() => training && setSelectedStartDate(date)}
                  style={{
                    flex: 1,
                    marginHorizontal: 3,
                    height: 76,
                    borderRadius: 14,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: selected ? '#e8ff47' : training ? '#111111' : '#0a0a0a',
                    borderWidth: 1,
                    borderColor: selected ? '#e8ff47' : training ? '#1a1a1a' : '#0f0f0f',
                    opacity: training ? 1 : 0.35,
                    shadowColor: selected ? '#e8ff47' : 'transparent',
                    shadowOffset: { width: 0, height: 0 },
                    shadowOpacity: selected ? 0.25 : 0,
                    shadowRadius: selected ? 8 : 0,
                    elevation: selected ? 4 : 0,
                  }}
                >
                  <Text style={{
                    fontSize: 10,
                    fontWeight: '700',
                    letterSpacing: 0.5,
                    color: selected ? '#080808' : training ? '#8a877f' : '#2a2a2a',
                    marginBottom: 4,
                    textTransform: 'uppercase',
                  }}>
                    {getDayAbbr(date)}
                  </Text>
                  <Text style={{
                    fontSize: 22,
                    fontWeight: '900',
                    fontFamily: 'BarlowCondensed_700Bold',
                    color: selected ? '#080808' : training ? '#f0ede8' : '#2a2a2a',
                    lineHeight: 24,
                  }}>
                    {getDateNum(date)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Session preview card */}
          <View style={{
            backgroundColor: '#111111',
            borderRadius: 16,
            padding: 20,
            borderLeftWidth: 3,
            borderLeftColor: '#e8ff47',
            marginBottom: 20,
          }}>
            <Text style={{
              fontSize: 11,
              fontWeight: '700',
              letterSpacing: 2,
              color: '#8a877f',
              textTransform: 'uppercase',
              marginBottom: 10,
            }}>
              Your First Session
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <View style={{
                backgroundColor: '#e8ff47',
                borderRadius: 4,
                paddingHorizontal: 7,
                paddingVertical: 3,
              }}>
                <Text style={{ color: '#080808', fontSize: 10, fontWeight: '800' }}>HARD</Text>
              </View>
              <Text style={{
                fontSize: 22,
                fontWeight: '800',
                color: '#f0ede8',
                fontFamily: 'BarlowCondensed_700Bold',
              }}>
                Run Time Trial
              </Text>
            </View>
            <Text style={{
              fontSize: 13,
              color: '#8a877f',
              lineHeight: 19,
            }}>
              Your pace + HR sets every future run zone. This is the number everything builds from.
            </Text>
          </View>

          {/* Bottom note */}
          <Text style={{
            fontSize: 12,
            color: '#8a877f',
            textAlign: 'center',
            lineHeight: 18,
          }}>
            Your program generates instantly after you tap.
          </Text>
        </ScrollView>

        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.continueBtn, !selectedStartDate && { opacity: 0.5 }]}
            onPress={handleBuildProgram}
            disabled={!selectedStartDate}
          >
            <Text style={styles.continueBtnText}>Start Day One →</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }


  if (closingPhase === 'generating') {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <Text style={styles.logo}>Peak 65</Text>
        <View style={{ flex: 1, paddingHorizontal: 24, justifyContent: 'center' }}>
          <Text style={{
            fontSize: 28,
            fontWeight: '800',
            color: '#f0ede8',
            marginBottom: 8,
            fontFamily: 'BarlowCondensed_700Bold',
          }}>Building your{'\n'}program.</Text>
          <Text style={{
            fontSize: 14,
            color: '#8a877f',
            marginBottom: 40,
            lineHeight: 20,
          }}>
            The AI is reading your data and building every session from scratch. This usually takes 1–2 minutes.
          </Text>
          {[
            'Analyzing your profile and goals',
            'Applying Peak 65 coaching methodology',
            'Calibrating your threshold zones',
            'Building your assessment sessions',
          ].map((item, idx) => (
            <View key={idx} style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              marginBottom: 16,
            }}>
              <View style={{
                width: 20,
                height: 20,
                borderRadius: 10,
                backgroundColor: checklistStep > idx ? '#e8ff47' : '#1a1a1a',
                borderWidth: 1,
                borderColor: checklistStep > idx ? '#e8ff47' : '#333',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                {checklistStep > idx && (
                  <Text style={{ color: '#080808', fontSize: 11, fontWeight: '900' }}>✓</Text>
                )}
              </View>
              <Text style={{
                fontSize: 14,
                color: checklistStep > idx ? '#f0ede8' : '#8a877f',
                fontWeight: checklistStep > idx ? '600' : '400',
                flex: 1,
              }}>{item}</Text>
            </View>
          ))}
          {apiError && (
            <TouchableOpacity
              style={[styles.continueBtn, { marginTop: 32 }]}
              onPress={callGenerateAssessment}
            >
              <Text style={styles.continueBtnText}>Try again</Text>
            </TouchableOpacity>
          )}
        </View>
      </SafeAreaView>
    );
  }

  // ── Splash ────────────────────────────────────────────────────────────────────

  if (showSplash) {
    return (
      <SafeAreaView style={styles.container} edges={['top','bottom']}>
        <Text style={styles.logo}>Peak 65</Text>
        <View style={styles.loadingBody}>
          <Text style={[styles.loadingTitle, { fontSize: 36, letterSpacing: -1 }]}>Let's build your program.</Text>
          <Text style={[styles.loadingSubtext, { marginTop: 12 }]}>Answer a few questions. We handle the rest.</Text>
        </View>
        <View style={styles.footer}>
          <TouchableOpacity style={styles.continueBtn} onPress={() => setShowSplash(false)}>
            <Text style={styles.continueBtnText}>Get Started</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── Main render ───────────────────────────────────────────────────────────────

  const hideFooter = noFooterSteps.includes(currentKey);
  const isScrollable = scrollableSteps.includes(currentKey);

  return (
    <SafeAreaView style={styles.container} edges={['top','bottom']}>
      <Text style={styles.logo}>Peak 65</Text>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={handleBack} disabled={step === 0} hitSlop={{ top:12, bottom:12, left:12, right:12 }}>
          {step > 0 && <Feather name="arrow-left" color={Colors.textPrimary} size={22} />}
        </TouchableOpacity>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
        </View>
        {currentKey === 'referral' ? (
          <TouchableOpacity style={styles.backBtn} onPress={skipStep}>
            <Text style={{ color: Colors.textSecondary, fontSize: 14 }}>Skip</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.backBtn} />
        )}
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <Animated.View style={[{ flex: 1 }, { opacity: stepOpacity }]}>
          {currentKey === 'aboutYou' ? (
            <View style={{ flex: 1 }}>{renderAboutYou()}</View>
          ) : isScrollable ? (
            <View style={styles.scrollableContainer}>
              {renderCurrentStep()}
            </View>
          ) : (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.scrollContent, { justifyContent: 'flex-start', paddingTop: 12 }]}
              keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              {renderCurrentStep()}
            </ScrollView>
          )}
        </Animated.View>

        {!hideFooter && (
          <View style={styles.footer}>
            <TouchableOpacity
              style={[styles.continueBtn, !canContinue && styles.continueBtnDisabled]}
              onPress={handleNext}
              disabled={!canContinue}
            >
              <Text style={styles.continueBtnText}>{continueLabel()}</Text>
            </TouchableOpacity>
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:    { flex:1, backgroundColor: Colors.background },
  logo:         { color: Colors.accent, fontSize: 36, fontFamily: Fonts.metricHeavy, textAlign: 'center', letterSpacing: -1, paddingTop: 8, paddingBottom: 4 },

  header:       { flexDirection:'row', alignItems:'center', paddingHorizontal:16, paddingVertical:14, gap:12 },
  backBtn:      { width:40, alignItems:'center', justifyContent:'center' },
  progressTrack:{ flex:1, height:4, backgroundColor: Colors.nested, borderRadius:2, overflow:'hidden' },
  progressFill: { height:'100%', backgroundColor: Colors.accent, borderRadius:2 },

  scrollContent:      { flexGrow:1, paddingHorizontal:24, paddingVertical:16 },
  scrollableContainer:{ flex:1, paddingHorizontal:24, paddingTop:8, paddingBottom:4 },
  stepContent:        { gap:12, paddingHorizontal:24 },

  label:     { color: Colors.textPrimary, fontSize: 26, fontWeight:'700', lineHeight:34, marginBottom:4 },
  sublabel:  { color: Colors.textSecondary, fontSize:14, lineHeight:20 },
  sectionHeader: { color: Colors.textSecondary, fontSize:11, fontWeight:'600', letterSpacing:2, marginBottom:4 },

  textInput:  { backgroundColor: Colors.card, borderWidth:1, borderColor: Colors.border, borderRadius:10, paddingHorizontal:16, paddingVertical:14, color: Colors.textPrimary, fontSize:18 },

  option:          { backgroundColor: Colors.card, borderWidth:1, borderColor: Colors.border, borderRadius:10, paddingHorizontal:16, paddingVertical:15 },
  optionSelected:  { backgroundColor: '#1a1a1a', borderLeftWidth: 3, borderLeftColor: '#e8ff47' },
  optionText:      { color: Colors.textPrimary, fontSize:16, lineHeight:22 },
  optionTextSelected: { color: '#e8ff47', fontWeight:'600' },

  goalCard:          { backgroundColor: Colors.card, borderWidth:1.5, borderColor: Colors.border, borderRadius:16, overflow:'hidden' },
  goalCardSelected:  { backgroundColor: '#1a1a1a', borderLeftWidth: 3, borderLeftColor: '#e8ff47' },
  goalCardInner:     { padding:20, gap:8 },
  goalCardTitle:     { color: Colors.textPrimary, fontSize:20, fontWeight:'700' },
  goalCardTitleSelected: { color: '#e8ff47' },
  goalCardSub:       { color: Colors.textSecondary, fontSize:14, lineHeight:20 },
  goalCardSubSelected: { color: Colors.textSecondary },

  twoCardRow:   { flexDirection:'row', gap:10 },
  halfCard:     { flex:1, backgroundColor: Colors.card, borderWidth:1.5, borderColor: Colors.border, borderRadius:14, height:56, alignItems:'center', justifyContent:'center' },
  halfCardSelected: { backgroundColor: '#1a1a1a', borderLeftWidth: 3, borderLeftColor: '#e8ff47' },
  halfCardTitle:{ color: Colors.textPrimary, fontSize:16, fontWeight:'700' },

  toggleRow:    { flexDirection:'row', backgroundColor: Colors.nested, borderRadius:10, padding:3, gap:3 },
  toggleBtn:    { flex:1, paddingVertical:8, alignItems:'center', borderRadius:8 },
  toggleBtnActive: { backgroundColor: Colors.accent },
  toggleBtnText:   { color: Colors.textSecondary, fontSize:14, fontWeight:'600' },
  toggleBtnTextActive: { color: Colors.background },

  divisionConfirmCard: { backgroundColor: Colors.card, borderWidth:1, borderColor:'rgba(232,255,71,0.2)', borderRadius:12, padding:16, gap:4 },
  divisionName:{ color: Colors.accent, fontSize:18, fontWeight:'700' },
  divisionDesc:{ color: Colors.textSecondary, fontSize:13 },

  tabRow:  { flexDirection:'row', backgroundColor: Colors.nested, borderRadius:10, padding:3, gap:3, marginBottom:12 },
  tab:     { flex:1, paddingVertical:8, alignItems:'center', borderRadius:8 },
  tabActive: { backgroundColor: Colors.card },
  tabText: { color: Colors.textSecondary, fontSize:13, fontWeight:'500' },
  tabTextActive: { color: Colors.textPrimary, fontWeight:'600' },

  eventCard:    { backgroundColor: Colors.card, borderWidth:1, borderColor: Colors.border, borderRadius:12, padding:14, marginBottom:8, flexDirection:'row', alignItems:'center' },
  eventCardSelected: { borderColor: Colors.accent, borderWidth:1.5 },
  eventCardMuted: { opacity:0.5 },
  eventCity:    { color: Colors.textPrimary, fontSize:18, fontWeight:'700' },
  eventCountry: { color: Colors.accent, fontSize:12, fontWeight:'600', marginTop:2 },
  eventVenue:   { color: Colors.textSecondary, fontSize:12, marginTop:2 },
  eventDate:    { color: Colors.textSecondary, fontSize:12 },
  weeksBadge:   { backgroundColor: Colors.accent, borderRadius:8, paddingHorizontal:10, paddingVertical:6 },
  weeksBadgeMuted: { backgroundColor: Colors.nested },
  weeksText:    { color: Colors.background, fontSize:13, fontWeight:'700' },
  raceSelectedBanner: { backgroundColor:'rgba(232,255,71,0.1)', borderWidth:1, borderColor:'rgba(232,255,71,0.3)', borderRadius:10, padding:12, marginTop:8, alignItems:'center' },
  raceSelectedText: { color: Colors.accent, fontWeight:'600', fontSize:14 },

  timeInputRow: { flexDirection:'row', alignItems:'center', justifyContent:'center', gap:8, marginVertical:8 },
  timeInput:    { backgroundColor: Colors.card, borderWidth:1, borderColor: Colors.border, borderRadius:12, paddingHorizontal:20, paddingVertical:16, color: Colors.accent, fontSize:48, fontWeight:'700', textAlign:'center', width:90 },
  timeColon:    { color: Colors.accent, fontSize:48, fontWeight:'700' },
  percentileHint: { color: Colors.textSecondary, fontSize:12, textAlign:'center', marginTop:-4 },

  presetCard:   { backgroundColor: Colors.card, borderWidth:1, borderColor: Colors.border, borderRadius:10, paddingHorizontal:16, paddingVertical:12, flexDirection:'row', alignItems:'center', justifyContent:'space-between' },
  presetCardSelected: { borderColor: Colors.accent, borderWidth:2 },
  presetLabel:  { color: Colors.textPrimary, fontSize:15, fontWeight:'600' },
  presetSub:    { color: Colors.textSecondary, fontSize:12, marginTop:2 },
  presetTime:   { color: Colors.accent, fontSize:18, fontWeight:'700' },

  weaknessCard:         { backgroundColor: '#111111', borderRadius:12, padding:14, borderLeftWidth:3, borderLeftColor:'transparent' },
  weaknessCardSelected: { backgroundColor: '#1a1a1a', borderLeftColor: '#e8ff47' },
  weaknessName:         { color: Colors.textPrimary, fontSize:15, fontWeight:'600' },
  weaknessNameSelected: { color: '#e8ff47' },
  weaknessDesc:         { color: '#8a877f', fontSize:13, marginTop:3, lineHeight:18 },

  searchRow:    { flexDirection:'row', gap:10, marginBottom:12 },
  searchBtn:    { backgroundColor: Colors.accent, borderRadius:10, paddingHorizontal:16, alignItems:'center', justifyContent:'center' },

  splitRow:     { flexDirection:'row', alignItems:'center', justifyContent:'space-between', paddingVertical:10, borderBottomWidth:1, borderBottomColor: Colors.border },
  splitLabel:   { color: Colors.textPrimary, fontSize:14, flex:1 },
  splitInput:   { backgroundColor: Colors.card, borderWidth:1, borderColor: Colors.border, borderRadius:8, paddingHorizontal:12, paddingVertical:8, color: Colors.accent, fontSize:16, fontWeight:'600', width:80, textAlign:'center' },

  raceResultCard: { backgroundColor: Colors.card, borderWidth:1, borderColor:'rgba(232,255,71,0.2)', borderRadius:12, padding:14, marginBottom:8 },
  raceResultName: { color: Colors.textPrimary, fontSize:16, fontWeight:'700' },
  raceResultMeta: { color: Colors.textSecondary, fontSize:12, marginTop:4 },

  secondaryBtn:     { backgroundColor: Colors.nested, borderRadius:10, paddingVertical:14, alignItems:'center' },
  secondaryBtnText: { color: Colors.textPrimary, fontSize:15, fontWeight:'600' },

  stationConfRow:   { flexDirection:'row', alignItems:'center', paddingVertical:12, borderBottomWidth:1, borderBottomColor: Colors.border },
  stationConfLabel: { color: Colors.textPrimary, fontSize:14, flex:1 },
  confDots:         { flexDirection:'row', gap:8 },
  confDot:          { width:16, height:16, borderRadius:8, borderWidth:1.5, borderColor: Colors.textSecondary, backgroundColor:'transparent' },
  confDotFilled:    { backgroundColor: Colors.accent, borderColor: Colors.accent },

  coachingCard:  { backgroundColor: Colors.card, borderWidth:1, borderColor:'rgba(232,255,71,0.15)', borderRadius:12, padding:14 },
  coachingText:  { color: Colors.textPrimary, fontSize:14, lineHeight:22 },

  descOption:      { backgroundColor: Colors.card, borderWidth:1, borderColor: Colors.border, borderRadius:12, padding:14 },
  descOptionSelected: { backgroundColor: '#1a1a1a', borderLeftWidth: 3, borderLeftColor: '#e8ff47' },
  descOptionTitle: { color: Colors.textPrimary, fontSize:15, fontWeight:'600' },
  descOptionSub:   { color: Colors.textSecondary, fontSize:13, marginTop:3, lineHeight:18 },

  twoByTwoGrid:  { flexDirection:'row', flexWrap:'wrap', gap:10 },
  gridBtn:       { flex:1, minWidth:'45%', backgroundColor: Colors.card, borderWidth:1, borderColor: Colors.border, borderRadius:12, paddingVertical:18, alignItems:'center' },
  gridBtnSelected: { backgroundColor: '#1a1a1a', borderLeftWidth: 3, borderLeftColor: '#e8ff47' },
  gridBtnText:   { color: Colors.textPrimary, fontSize:16, fontWeight:'600' },

  unitToggleRow:  { flexDirection:'row', alignItems:'center', justifyContent:'space-between', marginBottom:4 },
  unitToggle:     { flexDirection:'row', backgroundColor: Colors.nested, borderRadius:8, padding:2, gap:2 },
  unitBtn:        { paddingHorizontal:12, paddingVertical:4, borderRadius:6 },
  unitBtnActive:  { backgroundColor: Colors.accent },
  unitBtnText:    { color: Colors.textSecondary, fontSize:13, fontWeight:'500' },
  unitBtnTextActive: { color: Colors.background, fontWeight:'700' },

  dayGrid:         { flexDirection:'row', justifyContent:'space-between', marginVertical:8 },
  dayBtn:          { width:40, height:40, borderRadius:20, backgroundColor: Colors.card, borderWidth:1, borderColor: Colors.border, alignItems:'center', justifyContent:'center' },
  dayBtnSelected:  { backgroundColor: Colors.accent, borderColor: Colors.accent },
  dayBtnText:      { color: Colors.textSecondary, fontSize:14, fontWeight:'600' },
  dayBtnTextSelected: { color: Colors.background },
  daysSummaryCard: { backgroundColor: Colors.card, borderRadius:10, padding:12 },
  daysSummaryText: { color: Colors.accent, fontSize:14, fontWeight:'500' },

  doublesCard:     { backgroundColor: Colors.card, borderWidth:1, borderColor:'rgba(232,255,71,0.2)', borderRadius:12, padding:14, marginTop:8 },
  doublesQuestion: { color: Colors.textPrimary, fontSize:14, lineHeight:20 },

  toggleSwitchRow: { flexDirection:'row', alignItems:'center', justifyContent:'space-between', backgroundColor: Colors.card, borderRadius:12, padding:16, borderWidth:1, borderColor: Colors.border },

  milestoneCard:   { backgroundColor: Colors.card, borderWidth:1, borderColor: Colors.border, borderRadius:12, padding:14, gap:6 },
  milestoneMonth:  { color: Colors.accent, fontSize:13, fontWeight:'700', letterSpacing:1 },
  milestoneText:   { color: Colors.textPrimary, fontSize:14, lineHeight:20 },

  summaryHighlight:{ color: Colors.textPrimary, fontSize:16, marginTop:4, marginBottom:8 },
  accentText:      { color: Colors.accent, fontWeight:'700' },
  summaryRow:      { flexDirection:'row', justifyContent:'space-between', alignItems:'center', paddingVertical:10, borderBottomWidth:1, borderBottomColor: Colors.border },
  summaryLabel:    { color: Colors.textSecondary, fontSize:14 },
  summaryValue:    { color: Colors.textPrimary, fontSize:14, fontWeight:'600' },

  loadingBody:     { flex:1, alignItems:'center', justifyContent:'center', paddingHorizontal:24 },
  loadingTitle:    { color: Colors.textPrimary, fontSize:24, fontWeight:'700', textAlign:'center', lineHeight:32 },
  loadingSubtext:  { color: Colors.textSecondary, fontSize:15, textAlign:'center', marginTop:8 },

  checklistContainer: { marginTop:28, alignSelf:'stretch', gap:14 },
  checklistRow:    { flexDirection:'row', alignItems:'center', gap:12 },
  checklistDot:    { width:16, height:16, borderRadius:8, borderWidth:1.5, borderColor: Colors.textSecondary },
  checklistText:   { color: Colors.textSecondary, fontSize:15 },

  notifPreview:    { backgroundColor: Colors.card, borderRadius:16, padding:16, flexDirection:'row', alignItems:'center', gap:12, alignSelf:'stretch' },
  notifPreviewText:{ color: Colors.textPrimary, fontSize:14, flex:1, lineHeight:20 },

  assessDay:       { flexDirection:'row', alignItems:'center', gap:16, paddingVertical:10, borderBottomWidth:1, borderBottomColor: Colors.border },
  assessDayLabel:  { color: Colors.accent, fontSize:13, fontWeight:'700', width:48 },
  assessDaySession:{ color: Colors.textPrimary, fontSize:14, flex:1 },

  footer:          { paddingHorizontal:24, paddingTop:8, paddingBottom:16, gap:8 },
  skipBtn:         { alignItems:'center', paddingVertical:8 },
  skipText:        { color: Colors.textSecondary, fontSize:15, textDecorationLine:'underline' },
  continueBtn:     { backgroundColor: Colors.accent, borderRadius:10, paddingVertical:16, alignItems:'center' },
  continueBtnDisabled: { opacity:0.4 },
  continueBtnText: { color: Colors.background, fontSize:16, fontWeight:'700' },

  retryBtn:        { marginTop:8, paddingVertical:8, paddingHorizontal:16 },
  retryText:       { color: Colors.accent, fontSize:15, textAlign:'center', textDecorationLine:'underline' },
});
