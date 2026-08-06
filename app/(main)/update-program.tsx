import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  Animated, Platform, KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import DateTimePicker from '@react-native-community/datetimepicker';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { supabase } from '../../lib/supabase';
import type { MainStackParamList } from '../_layout';
import { Colors, Fonts } from '../../lib/theme';
import { Logo } from '../../components/Logo';
import { Feather } from '@expo/vector-icons';

type Props = NativeStackScreenProps<MainStackParamList, 'UpdateProgram'>;

// ─── Types ────────────────────────────────────────────────────────────────────

type StepKey =
  | 'goal'
  | 'raceDate'
  | 'division'
  | 'hyroxGoalTime'
  | 'stationWeaknesses'
  | 'fitnessGoal'
  | 'trainingDays'
  | 'restDayPreferences'
  | 'sessionLength'
  | 'availability'
  | 'doubleDays'
  | 'equipment'
  | 'review';

type FormData = {
  goal: string;
  raceDate: string;
  division: string;
  hyroxGoalTime: string;
  stationWeaknesses: string[];
  fitnessGoal: string;
  trainingDays: string;
  restDayPreferences: string[];
  doubleDays: string[];
  sessionLength: string;
  availability: string;
  equipment: string[];
};

// ─── Constants ────────────────────────────────────────────────────────────────

const DIVISION_OPTIONS = [
  'Men Open', 'Men Pro', 'Women Open', 'Women Pro', 'Mixed Doubles',
];

const HYROX_GOAL_TIMES = [
  'Sub 1:05 (Elite)',
  'Sub 1:15 (Competitive)',
  'Sub 1:30 (Strong Finisher)',
  'Just finish strong',
];

const STATION_OPTIONS = [
  'Ski Erg', 'Row Erg', 'Sled Push', 'Sled Pull',
  'Burpee Broad Jumps', 'Farmers Carry', 'Sandbag Lunges', 'Wall Balls', 'Unsure',
];

const HYROX_EQUIPMENT = [
  'Barbell + Rack', 'Dumbbells', 'Kettlebells', 'Pull-up Bar',
  'Ski Erg', 'Row Erg', 'Sled', 'Assault Bike', 'Full Gym Access',
];

const GF_EQUIPMENT = [
  'Barbell + Rack', 'Dumbbells', 'Kettlebells', 'Pull-up Bar',
  'Ski Erg', 'Row Erg', 'Assault Bike', 'Full Gym Access', 'No Equipment',
];

const ALL_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const GEN_MESSAGES = [
  'Analyzing your profile...',
  'Rebuilding your training plan...',
  'Calibrating to your goals...',
  'Writing your coaching cues...',
  'Almost ready...',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getRequiredRestDays(trainingDays: string): number {
  if (trainingDays === '6') return 1;
  if (trainingDays === '5') return 2;
  if (trainingDays === '4') return 3;
  return 2;
}

function getSteps(goal: string, availability: string): StepKey[] {
  const endSteps: StepKey[] = ['trainingDays', 'restDayPreferences', 'sessionLength', 'availability'];
  if (availability === 'both') endSteps.push('doubleDays');
  endSteps.push('equipment', 'review');

  if (goal === 'hyrox') {
    return ['goal', 'raceDate', 'division', 'hyroxGoalTime', 'stationWeaknesses', ...endSteps];
  }
  return ['goal', 'fitnessGoal', ...endSteps];
}

function parseArr(val: string[] | string | null | undefined): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  const m = val.match(/^\{(.*)\}$/s);
  if (!m || !m[1].length) return [];
  return m[1].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
}

function fmtGoal(v: string): string {
  return v === 'hyrox' ? 'Train for Hyrox' : v === 'general_fitness' ? 'General Fitness' : v || '—';
}
function fmtLen(v: string): string {
  return v === '60' ? '~1 hour' : v === '90' ? '~1.5–2 hours' : v || '—';
}
function fmtAvail(v: string): string {
  return v === 'once' ? 'Once a day' : v === 'both' ? 'Twice a day (AM + PM)' : v || '—';
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function UpdateProgramScreen({ navigation }: Props) {
  const [userId, setUserId]         = useState('');
  const [loading, setLoading]       = useState(true);
  // Pinnacle athletes' programs are hand-built by their coach. This screen
  // deletes and rebuilds programs, so it must refuse to run for them.
  const [isElite, setIsElite]       = useState(false);
  const [step, setStep]             = useState(0);
  const [form, setForm]             = useState<FormData>({
    goal: '', raceDate: '', division: '', hyroxGoalTime: '', stationWeaknesses: [],
    fitnessGoal: '', trainingDays: '', restDayPreferences: [], doubleDays: [],
    sessionLength: '', availability: '', equipment: [],
  });
  const [original, setOriginal]     = useState<FormData | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError]     = useState(false);
  const [genMsgIdx, setGenMsgIdx]   = useState(0);
  const [genBarWidth, setGenBarWidth] = useState(0);
  const [androidDateOpen, setAndroidDateOpen] = useState(false);

  const msgOpacity   = useRef(new Animated.Value(0)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;
  const cycleRef     = useRef<Animated.CompositeAnimation | null>(null);
  const progRef      = useRef<Animated.CompositeAnimation | null>(null);
  const alive        = useRef(true);
  const backup       = useRef<any[]>([]);
  const didDeletePrograms = useRef(false);
  const hasLoadedRef = useRef(false);

  // ── Load profile ──────────────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) { setLoading(false); return; }
      setUserId(auth.user.id);

      const { data: p } = await supabase
        .from('profiles').select('*')
        .eq('id', auth.user.id).maybeSingle();
      if (!p) { setLoading(false); return; }

      if (p.tier === 'elite') { setIsElite(true); setLoading(false); return; }

      // Map old current_training_days formats to exact number strings
      let trainingDays = '';
      const raw = p.current_training_days;
      if (['4', '5', '6'].includes(raw)) {
        trainingDays = raw;
      } else if (raw === '1-2 days' || raw === '3-4 days') {
        trainingDays = '4';
      } else if (raw === '5+ days') {
        trainingDays = '5';
      } else {
        trainingDays = '5';
      }

      const init: FormData = {
        goal:               p.goal ?? '',
        raceDate:           p.race_date ?? '',
        division:           p.hyrox_division ?? '',
        hyroxGoalTime:      p.hyrox_goal_time ?? '',
        stationWeaknesses:  parseArr(p.station_weaknesses),
        fitnessGoal:        p.fitness_goal ?? '',
        trainingDays,
        restDayPreferences: parseArr(p.rest_day_preferences),
        doubleDays:         parseArr(p.double_day_preferences),
        sessionLength:      p.session_length ?? '',
        availability:       p.availability ?? '',
        equipment:          parseArr(p.equipment_access),
      };
      setForm(init);
      setOriginal({ ...init });
      setLoading(false);
      setTimeout(() => { hasLoadedRef.current = true; }, 0);
    })();

    return () => {
      alive.current = false;
      cycleRef.current?.stop();
      progRef.current?.stop();
    };
  }, []);

  // Clear rest/double day selections when training days count changes (skip on initial load)
  useEffect(() => {
    if (!hasLoadedRef.current) return;
    if (form.trainingDays !== '') {
      setForm(prev => ({ ...prev, restDayPreferences: [], doubleDays: [] }));
    }
  }, [form.trainingDays]);

  // ── Step sequence ─────────────────────────────────────────────────────────

  const steps = getSteps(form.goal || 'hyrox', form.availability);
  const currentKey: StepKey = steps[step] ?? 'review';
  const progress = steps.length > 1 ? step / (steps.length - 1) : 1;

  function canContinue(): boolean {
    switch (currentKey) {
      case 'goal':              return form.goal !== '';
      case 'raceDate':          return true;
      case 'division':          return form.division !== '';
      case 'hyroxGoalTime':     return form.hyroxGoalTime !== '';
      case 'stationWeaknesses': return form.stationWeaknesses.length > 0;
      case 'fitnessGoal':       return form.fitnessGoal !== '';
      case 'trainingDays':      return form.trainingDays !== '';
      case 'restDayPreferences': {
        const required = getRequiredRestDays(form.trainingDays);
        return form.restDayPreferences.length === required;
      }
      case 'sessionLength':     return form.sessionLength !== '';
      case 'availability':      return form.availability !== '';
      case 'doubleDays':        return form.doubleDays.length > 0;
      case 'equipment':         return form.equipment.length > 0;
      case 'review':            return true;
      default:                  return true;
    }
  }

  function handleBack() {
    if (generating) return;
    if (step === 0) { navigation.goBack(); return; }
    setStep(s => s - 1);
  }

  function handleNext() {
    if (!canContinue()) return;
    const seq = getSteps(form.goal, form.availability);
    if (step < seq.length - 1) setStep(s => s + 1);
  }

  function toggleEquipment(item: string) {
    setForm(prev => {
      const arr = prev.equipment;
      const allOpts = prev.goal === 'hyrox' ? HYROX_EQUIPMENT : GF_EQUIPMENT;

      if (item === 'No Equipment') {
        return { ...prev, equipment: arr.includes('No Equipment') ? [] : ['No Equipment'] };
      }
      if (item === 'Full Gym Access') {
        const fullSet = allOpts.filter(o => o !== 'No Equipment');
        return { ...prev, equipment: arr.includes('Full Gym Access') ? [] : fullSet };
      }
      if (arr.includes(item)) {
        return { ...prev, equipment: arr.filter(e => e !== item && e !== 'Full Gym Access') };
      }
      return { ...prev, equipment: [...arr.filter(e => e !== 'No Equipment'), item] };
    });
  }

  function toggleWeakness(item: string) {
    setForm(prev => ({
      ...prev,
      stationWeaknesses: prev.stationWeaknesses.includes(item)
        ? prev.stationWeaknesses.filter(s => s !== item)
        : [...prev.stationWeaknesses, item],
    }));
  }

  function toggleRestDayPref(day: string) {
    const max = getRequiredRestDays(form.trainingDays);
    setForm(prev => {
      const arr = prev.restDayPreferences;
      if (arr.includes(day)) return { ...prev, restDayPreferences: arr.filter(d => d !== day) };
      if (arr.length >= max) return prev;
      return { ...prev, restDayPreferences: [...arr, day] };
    });
  }

  function toggleDoubleDay(day: string) {
    setForm(prev => ({
      ...prev,
      doubleDays: prev.doubleDays.includes(day)
        ? prev.doubleDays.filter(d => d !== day)
        : [...prev.doubleDays, day],
    }));
  }

  // ── Generating animation ──────────────────────────────────────────────────

  function startAnimation() {
    alive.current = true;
    progressAnim.setValue(0);
    msgOpacity.setValue(0);
    setGenMsgIdx(0);
    animMsg(0);
    const p = Animated.timing(progressAnim, { toValue: 1, duration: 90_000, useNativeDriver: false });
    progRef.current = p;
    p.start();
  }

  function animMsg(idx: number) {
    if (!alive.current) return;
    setGenMsgIdx(idx);
    const seq = Animated.sequence([
      Animated.timing(msgOpacity, { toValue: 1, duration: 600,  useNativeDriver: true }),
      Animated.delay(3000),
      Animated.timing(msgOpacity, { toValue: 0, duration: 400,  useNativeDriver: true }),
    ]);
    cycleRef.current = seq;
    seq.start(({ finished }) => {
      if (finished && alive.current) animMsg((idx + 1) % GEN_MESSAGES.length);
    });
  }

  function stopAnimation() {
    alive.current = false;
    cycleRef.current?.stop();
    progRef.current?.stop();
  }

  // ── Confirm ───────────────────────────────────────────────────────────────

  async function handleConfirm() {
    if (!userId) return;
    // Never delete or rebuild a coach-built program. Unreachable behind the
    // render guard below; kept here so no future edit can route around it.
    if (isElite) return;
    setGenerating(true);
    setGenError(false);
    startAnimation();

    try {
      // 1. Backup + delete existing programs
      const { data: programs } = await supabase
        .from('programs').select('*').eq('user_id', userId);
      backup.current = programs ?? [];
      await supabase.from('programs').delete().eq('user_id', userId);
      didDeletePrograms.current = true;

      // 2. Update profile
      const restDaysCount = getRequiredRestDays(form.trainingDays);
      const validDoubleDays = form.doubleDays.filter(d => !form.restDayPreferences.includes(d));

      const patch: Record<string, any> = {
        goal:                   form.goal,
        current_training_days:  form.trainingDays || null,
        rest_day_preferences:   form.restDayPreferences.length > 0 ? form.restDayPreferences : null,
        rest_days:              form.trainingDays ? restDaysCount : null,
        double_day_preferences: validDoubleDays.length > 0 ? validDoubleDays : null,
        session_length:         form.sessionLength || null,
        availability:           form.availability || null,
        equipment_access:       form.equipment.length > 0 ? form.equipment : null,
      };

      if (form.goal === 'hyrox') {
        patch.hyrox_division      = form.division       || null;
        patch.race_date           = form.raceDate        || null;
        patch.hyrox_goal_time     = form.hyroxGoalTime   || null;
        patch.station_weaknesses  = form.stationWeaknesses.length > 0 ? form.stationWeaknesses : null;
      }
      if (form.goal === 'general_fitness') {
        patch.fitness_goal = form.fitnessGoal || null;
      }

      await supabase.from('profiles').update(patch).eq('id', userId);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 3. Generate new program
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 120_000);
      const res = await fetch('https://peak65.vercel.app/api/generate-assessment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ userId }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      stopAnimation();
      (navigation as any).navigate('Tabs', { screen: 'Program' });
    } catch (e) {
      console.log('[update-program] generate error:', e);
      stopAnimation();
      setGenError(true);

      if (didDeletePrograms.current && backup.current.length > 0) {
        try {
          await supabase.from('programs').upsert(backup.current, { onConflict: 'id' });
        } catch (restoreErr) {
          console.log('[update-program] restore error:', restoreErr);
        }
      }
    }
  }

  async function handleRetry() {
    // Same rule as handleConfirm — no regeneration for a coached athlete.
    if (isElite) return;
    setGenError(false);
    startAnimation();
    try {
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 120_000);
      const res = await fetch('https://peak65.vercel.app/api/generate-assessment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ userId }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      stopAnimation();
      (navigation as any).navigate('Tabs', { screen: 'Program' });
    } catch (e) {
      stopAnimation();
      setGenError(true);
    }
  }

  // ── Render helpers ────────────────────────────────────────────────────────

  function renderOpt(label: string, selected: boolean, onPress: () => void) {
    return (
      <TouchableOpacity
        key={label}
        style={[s.option, selected && s.optionSelected]}
        onPress={onPress}
      >
        <Text style={[s.optionText, selected && s.optionTextSelected]}>{label}</Text>
      </TouchableOpacity>
    );
  }

  function renderCurrentStep() {
    switch (currentKey) {
      case 'goal':
        return (
          <View style={s.stepContent}>
            <Text style={s.label}>What is your training goal?</Text>
            {renderOpt('Train for Hyrox', form.goal === 'hyrox', () => setForm(p => ({ ...p, goal: 'hyrox' })))}
            {renderOpt('General Fitness', form.goal === 'general_fitness', () => setForm(p => ({ ...p, goal: 'general_fitness' })))}
          </View>
        );

      case 'raceDate': {
        const pickerDate = form.raceDate
          ? new Date(form.raceDate)
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        return (
          <View style={s.stepContent}>
            <Text style={s.label}>When is your next Hyrox race?</Text>
            <Text style={s.sublabel}>Skip if you don't have one yet</Text>
            {Platform.OS === 'ios' ? (
              <DateTimePicker
                value={pickerDate}
                mode="date"
                display="inline"
                themeVariant="dark"
                accentColor={Colors.accent}
                minimumDate={new Date()}
                onChange={(_e, d) => {
                  if (d) setForm(p => ({ ...p, raceDate: d.toISOString().split('T')[0] }));
                }}
                style={{ marginVertical: 8 }}
              />
            ) : (
              <>
                <TouchableOpacity style={s.option} onPress={() => setAndroidDateOpen(true)}>
                  <Text style={s.optionText}>{form.raceDate || 'Tap to select date'}</Text>
                </TouchableOpacity>
                {androidDateOpen && (
                  <DateTimePicker
                    value={pickerDate}
                    mode="date"
                    display="default"
                    minimumDate={new Date()}
                    onChange={(_e, d) => {
                      setAndroidDateOpen(false);
                      if (d) setForm(p => ({ ...p, raceDate: d.toISOString().split('T')[0] }));
                    }}
                  />
                )}
              </>
            )}
          </View>
        );
      }

      case 'division':
        return (
          <View style={s.stepContent}>
            <Text style={s.label}>What's your division?</Text>
            {DIVISION_OPTIONS.map(d =>
              renderOpt(d, form.division === d, () => setForm(p => ({ ...p, division: d })))
            )}
          </View>
        );

      case 'hyroxGoalTime':
        return (
          <View style={s.stepContent}>
            <Text style={s.label}>What's your goal finish time?</Text>
            {HYROX_GOAL_TIMES.map(t =>
              renderOpt(t, form.hyroxGoalTime === t, () => setForm(p => ({ ...p, hyroxGoalTime: t })))
            )}
          </View>
        );

      case 'stationWeaknesses':
        return (
          <View style={[s.stepContent, { flex: 1 }]}>
            <Text style={s.label}>Which Hyrox stations are your biggest weakness?</Text>
            <Text style={s.sublabel}>Select all that apply</Text>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 20 }} showsVerticalScrollIndicator={false}>
              {STATION_OPTIONS.map(opt => (
                <TouchableOpacity
                  key={opt}
                  style={[s.option, form.stationWeaknesses.includes(opt) && s.optionSelected]}
                  onPress={() => toggleWeakness(opt)}
                >
                  <Text style={[s.optionText, form.stationWeaknesses.includes(opt) && s.optionTextSelected]}>{opt}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        );

      case 'fitnessGoal':
        return (
          <View style={s.stepContent}>
            <Text style={s.label}>What is your primary goal?</Text>
            {renderOpt('Look better',         form.fitnessGoal === 'look_better',         () => setForm(p => ({ ...p, fitnessGoal: 'look_better' })))}
            {renderOpt('Get stronger',        form.fitnessGoal === 'get_stronger',        () => setForm(p => ({ ...p, fitnessGoal: 'get_stronger' })))}
            {renderOpt('Improve performance', form.fitnessGoal === 'improve_performance', () => setForm(p => ({ ...p, fitnessGoal: 'improve_performance' })))}
            {renderOpt('All-around fitness',  form.fitnessGoal === 'all_around',          () => setForm(p => ({ ...p, fitnessGoal: 'all_around' })))}
          </View>
        );

      case 'trainingDays':
        return (
          <View style={s.stepContent}>
            <Text style={s.label}>How many days per week will you train?</Text>
            {(['4', '5', '6'] as const).map(d =>
              renderOpt(`${d} days`, form.trainingDays === d, () => setForm(p => ({ ...p, trainingDays: d })))
            )}
          </View>
        );

      case 'restDayPreferences': {
        const required = getRequiredRestDays(form.trainingDays);
        const nLabel = required === 1 ? '1 rest day' : `${required} rest days`;
        return (
          <View style={s.stepContent}>
            <Text style={s.label}>Which days would you like to rest?</Text>
            <Text style={s.sublabel}>
              {`Select ${nLabel} — ${form.restDayPreferences.length} of ${required} selected`}
            </Text>
            {ALL_DAYS.map(day => (
              <TouchableOpacity
                key={day}
                style={[s.option, form.restDayPreferences.includes(day) && s.optionSelected]}
                onPress={() => toggleRestDayPref(day)}
              >
                <Text style={[s.optionText, form.restDayPreferences.includes(day) && s.optionTextSelected]}>{day}</Text>
              </TouchableOpacity>
            ))}
          </View>
        );
      }

      case 'sessionLength':
        return (
          <View style={s.stepContent}>
            <Text style={s.label}>How much time do you have per session?</Text>
            {renderOpt('About 1 hour',      form.sessionLength === '60', () => setForm(p => ({ ...p, sessionLength: '60' })))}
            {renderOpt('About 1.5–2 hours', form.sessionLength === '90', () => setForm(p => ({ ...p, sessionLength: '90' })))}
          </View>
        );

      case 'availability':
        return (
          <View style={s.stepContent}>
            <Text style={s.label}>When are you available to train?</Text>
            {renderOpt('Once a day',            form.availability === 'once', () => setForm(p => ({ ...p, availability: 'once' })))}
            {renderOpt('Twice a day (AM + PM)', form.availability === 'both', () => setForm(p => ({ ...p, availability: 'both' })))}
          </View>
        );

      case 'doubleDays': {
        const trainingDays = ALL_DAYS.filter(d => !form.restDayPreferences.includes(d));
        return (
          <View style={s.stepContent}>
            <Text style={s.label}>Which days can you train twice?</Text>
            <Text style={s.sublabel}>Select all days when you can do both AM and PM sessions</Text>
            {trainingDays.map(day => (
              <TouchableOpacity
                key={day}
                style={[s.option, form.doubleDays.includes(day) && s.optionSelected]}
                onPress={() => toggleDoubleDay(day)}
              >
                <Text style={[s.optionText, form.doubleDays.includes(day) && s.optionTextSelected]}>{day}</Text>
              </TouchableOpacity>
            ))}
          </View>
        );
      }

      case 'equipment': {
        const opts = form.goal === 'hyrox' ? HYROX_EQUIPMENT : GF_EQUIPMENT;
        return (
          <View style={[s.stepContent, { flex: 1 }]}>
            <Text style={s.label}>What equipment do you have access to?</Text>
            <Text style={s.sublabel}>Select all that apply</Text>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 20 }} showsVerticalScrollIndicator={false}>
              {opts.map(opt => (
                <TouchableOpacity
                  key={opt}
                  style={[s.option, form.equipment.includes(opt) && s.optionSelected]}
                  onPress={() => toggleEquipment(opt)}
                >
                  <Text style={[s.optionText, form.equipment.includes(opt) && s.optionTextSelected]}>{opt}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        );
      }

      case 'review': {
        if (!original) return null;
        const isHyrox = form.goal === 'hyrox';

        function fmtFitnessGoal(v: string): string {
          const map: Record<string, string> = {
            look_better: 'Look better', get_stronger: 'Get stronger',
            improve_performance: 'Improve performance', all_around: 'All-around fitness',
          };
          return map[v] || v || '—';
        }

        const fields: { label: string; oldVal: string; newVal: string }[] = [
          { label: 'Goal', oldVal: fmtGoal(original.goal), newVal: fmtGoal(form.goal) },
          ...(isHyrox ? [
            { label: 'Race Date',    oldVal: original.raceDate      || 'Not set', newVal: form.raceDate      || 'Not set' },
            { label: 'Division',     oldVal: original.division      || '—',       newVal: form.division      || '—' },
            { label: 'Goal Time',    oldVal: original.hyroxGoalTime || '—',       newVal: form.hyroxGoalTime || '—' },
            { label: 'Weaknesses',   oldVal: original.stationWeaknesses.join(', ') || 'None', newVal: form.stationWeaknesses.join(', ') || 'None' },
          ] : [
            { label: 'Primary Goal', oldVal: fmtFitnessGoal(original.fitnessGoal), newVal: fmtFitnessGoal(form.fitnessGoal) },
          ]),
          { label: 'Training Days', oldVal: original.trainingDays ? `${original.trainingDays} days/wk` : '—', newVal: form.trainingDays ? `${form.trainingDays} days/wk` : '—' },
          { label: 'Rest Days',     oldVal: original.restDayPreferences.join(', ') || '—', newVal: form.restDayPreferences.join(', ') || '—' },
          { label: 'Session',       oldVal: fmtLen(original.sessionLength),   newVal: fmtLen(form.sessionLength) },
          { label: 'Availability',  oldVal: fmtAvail(original.availability),  newVal: fmtAvail(form.availability) },
          { label: 'Double Days',   oldVal: original.doubleDays.join(', ') || 'None', newVal: form.doubleDays.join(', ') || 'None' },
          { label: 'Equipment',     oldVal: original.equipment.join(', ') || 'None', newVal: form.equipment.join(', ') || 'None' },
        ];

        const hasChanges = fields.some(f => f.oldVal !== f.newVal);
        return (
          <View style={s.stepContent}>
            <Text style={s.label}>Review your changes</Text>
            <Text style={s.sublabel}>
              {hasChanges
                ? 'Changed fields are highlighted. Confirming will rebuild your program.'
                : 'No changes detected. Confirming will still rebuild your program with the same settings.'}
            </Text>
            <View style={s.reviewCard}>
              {fields.map(f => {
                const changed = f.oldVal !== f.newVal;
                return (
                  <View key={f.label} style={s.reviewRow}>
                    <Text style={[s.reviewLabel, changed && { color: Colors.accent }]}>{f.label}</Text>
                    <View style={s.reviewValues}>
                      {changed && <Text style={s.reviewOld}>{f.oldVal}</Text>}
                      <Text style={[s.reviewNew, changed && { color: Colors.accent }]}>{f.newVal}</Text>
                    </View>
                  </View>
                );
              })}
            </View>
          </View>
        );
      }

      default: return null;
    }
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  if (loading) return null;

  // Pinnacle athletes never reach the edit flow. Their coach owns the program,
  // and this screen's first act is to delete every program row. Rendered before
  // the generating branch so no state can slip past it.
  if (isElite) {
    return (
      <SafeAreaView style={s.container} edges={['top', 'bottom']}>
        <Logo width={150} />
        <View style={s.header}>
          <TouchableOpacity
            style={s.backBtn}
            onPress={() => navigation.goBack()}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Feather name="arrow-left" color={Colors.textPrimary} size={22} />
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          <View style={s.backBtn} />
        </View>
        <View style={s.blockedBody}>
          <Text style={s.blockedHeading}>Your coach manages your training plan.</Text>
          <Text style={s.blockedSub}>Message your coach if something needs to change.</Text>
          <TouchableOpacity style={s.blockedBtn} onPress={() => navigation.goBack()}>
            <Text style={s.blockedBtnText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── Generating screen ─────────────────────────────────────────────────────

  if (generating) {
    const animWidth = progressAnim.interpolate({ inputRange: [0, 1], outputRange: [0, genBarWidth] });
    return (
      <SafeAreaView style={s.container} edges={['top', 'bottom']}>
        <Logo width={150} />
        <View style={s.genBody}>
          <Text style={s.genHeading}>Rebuilding your program</Text>
          {genError ? (
            <TouchableOpacity onPress={handleRetry} style={s.retryBtn}>
              <Text style={s.retryText}>Something went wrong. Tap to try again.</Text>
            </TouchableOpacity>
          ) : (
            <Animated.Text style={[s.genMsg, { opacity: msgOpacity }]}>
              {GEN_MESSAGES[genMsgIdx]}
            </Animated.Text>
          )}
        </View>
        <View
          style={s.progressTrack}
          onLayout={e => setGenBarWidth(e.nativeEvent.layout.width)}
        >
          <Animated.View style={[s.progressFill, { width: animWidth }]} />
        </View>
      </SafeAreaView>
    );
  }

  // ── Main flow ─────────────────────────────────────────────────────────────

  const isEquipmentOrStations = currentKey === 'equipment' || currentKey === 'stationWeaknesses';
  const isReviewStep  = currentKey === 'review';
  const isRaceDateStep = currentKey === 'raceDate';

  return (
    <SafeAreaView style={s.container} edges={['top', 'bottom']}>
      <Logo width={150} />

      <View style={s.header}>
        <TouchableOpacity
          style={s.backBtn}
          onPress={handleBack}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Feather name="arrow-left" color={Colors.textPrimary} size={22} />
        </TouchableOpacity>
        <View style={s.progressBarTrack}>
          <View style={[s.progressBarFill, { width: `${progress * 100}%` as any }]} />
        </View>
        <View style={s.backBtn} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        {isEquipmentOrStations ? (
          <View style={s.multiContainer}>
            {renderCurrentStep()}
          </View>
        ) : (
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={s.scrollContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {renderCurrentStep()}
          </ScrollView>
        )}

        <View style={s.footer}>
          {isRaceDateStep && (
            <TouchableOpacity style={s.skipBtn} onPress={handleNext}>
              <Text style={s.skipText}>I don't have a race yet</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[s.continueBtn, !canContinue() && s.continueBtnDisabled]}
            onPress={isReviewStep ? handleConfirm : handleNext}
            disabled={!canContinue()}
          >
            <Text style={s.continueBtnText}>
              {isReviewStep ? 'Confirm & Rebuild' : 'Continue'}
            </Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

  // Coach-managed (Pinnacle) blocked state
  blockedBody: {
    flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, paddingHorizontal: 32,
  },
  blockedHeading: {
    color: Colors.textPrimary, fontSize: 22, fontWeight: '700',
    textAlign: 'center', lineHeight: 30,
  },
  blockedSub: {
    color: Colors.textSecondary, fontSize: 15, textAlign: 'center', lineHeight: 22, maxWidth: 280,
  },
  blockedBtn: {
    marginTop: 8, borderWidth: 1.5, borderColor: Colors.accent,
    borderRadius: 14, paddingVertical: 15, paddingHorizontal: 32,
  },
  blockedBtnText: { color: Colors.accent, fontSize: 16, fontWeight: '700' },

  logo: {
    color: Colors.accent, fontSize: 36, fontFamily: Fonts.metricHeavy,
    textAlign: 'center', letterSpacing: -1, paddingTop: 8, paddingBottom: 4,
  },

  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 12, gap: 12,
  },
  backBtn: { width: 32 },
  progressBarTrack: {
    flex: 1, height: 3, backgroundColor: Colors.nested, borderRadius: 2, overflow: 'hidden',
  },
  progressBarFill: { height: 3, backgroundColor: Colors.accent, borderRadius: 2 },

  scrollContent: {
    flexGrow: 1, justifyContent: 'center',
    paddingHorizontal: 24, paddingBottom: 20,
  },
  multiContainer: { flex: 1, paddingHorizontal: 24, paddingTop: 4 },

  stepContent: { gap: 10 },
  label: {
    color: Colors.textPrimary, fontSize: 22, fontWeight: '800',
    lineHeight: 28, marginBottom: 8, letterSpacing: -0.3,
  },
  sublabel: { color: Colors.textSecondary, fontSize: 13, marginTop: -4, marginBottom: 4, lineHeight: 18 },

  option: {
    backgroundColor: Colors.card, borderRadius: 12, paddingVertical: 16,
    paddingHorizontal: 18, borderWidth: 1, borderColor: Colors.border,
  },
  optionSelected:     { backgroundColor: Colors.accent, borderColor: Colors.accent },
  optionText:         { color: Colors.textPrimary, fontSize: 16 },
  optionTextSelected: { color: Colors.background, fontWeight: '700' },

  footer:   { paddingHorizontal: 24, paddingBottom: 20, paddingTop: 8, gap: 10 },
  skipBtn:  { alignItems: 'center', paddingVertical: 4 },
  skipText: { color: Colors.textSecondary, fontSize: 15, textDecorationLine: 'underline' },
  continueBtn: {
    backgroundColor: Colors.accent, borderRadius: 14, paddingVertical: 18, alignItems: 'center',
  },
  continueBtnDisabled: { opacity: 0.35 },
  continueBtnText: { color: Colors.background, fontSize: 16, fontWeight: '800', letterSpacing: 0.3 },

  // Review
  reviewCard: {
    backgroundColor: Colors.card, borderRadius: 14, overflow: 'hidden', marginTop: 8,
  },
  reviewRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    paddingHorizontal: 16, paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#222',
  },
  reviewLabel:  { color: Colors.textSecondary, fontSize: 14, fontWeight: '600', flex: 1 },
  reviewValues: { flex: 2, alignItems: 'flex-end', gap: 2 },
  reviewOld:    { color: Colors.textSecondary, fontSize: 12, textDecorationLine: 'line-through' },
  reviewNew:    { color: Colors.textPrimary, fontSize: 14, fontWeight: '600', textAlign: 'right' },

  // Generating
  genBody: {
    flex: 1, alignItems: 'center', justifyContent: 'center', gap: 28, paddingHorizontal: 24,
  },
  genHeading: { color: Colors.textPrimary, fontSize: 18, fontWeight: '600', textAlign: 'center' },
  genMsg: {
    color: Colors.accent, fontSize: 26, fontFamily: Fonts.metric,
    textAlign: 'center', letterSpacing: -0.3, lineHeight: 34,
  },
  retryBtn:  { paddingVertical: 8, paddingHorizontal: 16 },
  retryText: { color: Colors.accent, fontSize: 15, textAlign: 'center', textDecorationLine: 'underline' },
  progressTrack: {
    height: 2, backgroundColor: Colors.nested, borderRadius: 1,
    marginHorizontal: 24, marginBottom: 24, overflow: 'hidden',
  },
  progressFill: { height: 2, backgroundColor: Colors.accent, borderRadius: 1 },
});
