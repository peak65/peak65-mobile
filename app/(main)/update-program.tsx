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

type Props = NativeStackScreenProps<MainStackParamList, 'UpdateProgram'>;

const YELLOW    = '#e8ff47';
const BLACK     = '#080808';
const OFF_WHITE = '#f0ede8';
const GREY      = '#8a877f';

// ─── Types ────────────────────────────────────────────────────────────────────

type StepKey =
  | 'goal'
  | 'raceDate'
  | 'division'
  | 'trainingDays'
  | 'sessionLength'
  | 'availability'
  | 'restDays'
  | 'equipment'
  | 'runConfidence'
  | 'review';

type FormData = {
  goal: string;
  raceDate: string;
  division: string;
  trainingDays: string;
  sessionLength: string;
  availability: string;
  restDays: string;
  equipment: string[];
  runConfidence: number;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const DIVISION_OPTIONS = [
  'Men Open', 'Men Pro', 'Women Open', 'Women Pro', 'Mixed Doubles',
];

const HYROX_EQUIPMENT = [
  'Barbell + Rack', 'Dumbbells', 'Kettlebells', 'Pull-up Bar',
  'Ski Erg', 'Row Erg', 'Sled', 'Assault Bike', 'Full Gym Access',
];

const GF_EQUIPMENT = [
  'Barbell + Rack', 'Dumbbells', 'Kettlebells', 'Pull-up Bar',
  'Ski Erg', 'Row Erg', 'Assault Bike', 'Full Gym Access', 'No Equipment',
];

const GEN_MESSAGES = [
  'Analyzing your profile...',
  'Rebuilding your training plan...',
  'Calibrating to your goals...',
  'Writing your coaching cues...',
  'Almost ready...',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getSteps(goal: string): StepKey[] {
  if (goal === 'hyrox') {
    return ['goal', 'raceDate', 'division', 'trainingDays', 'sessionLength', 'availability', 'restDays', 'equipment', 'runConfidence', 'review'];
  }
  return ['goal', 'trainingDays', 'sessionLength', 'availability', 'restDays', 'equipment', 'review'];
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
function fmtRestDays(v: string): string {
  return v === '1' ? '1 day' : v ? `${v} days` : '—';
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function UpdateProgramScreen({ navigation }: Props) {
  const [userId, setUserId]         = useState('');
  const [loading, setLoading]       = useState(true);
  const [step, setStep]             = useState(0);
  const [form, setForm]             = useState<FormData>({
    goal: '', raceDate: '', division: '', trainingDays: '',
    sessionLength: '', availability: '', restDays: '', equipment: [], runConfidence: 3,
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

      const init: FormData = {
        goal:          p.goal ?? '',
        raceDate:      p.race_date ?? '',
        division:      p.hyrox_division ?? '',
        trainingDays:  ['3','4','5','6'].includes(p.current_training_days) ? p.current_training_days : '',
        sessionLength: p.session_length ?? '',
        availability:  p.availability ?? '',
        restDays:      p.rest_days != null ? String(p.rest_days) : '',
        equipment:     parseArr(p.equipment_access),
        runConfidence: typeof p.run_confidence === 'number' ? p.run_confidence : 3,
      };
      setForm(init);
      setOriginal({ ...init });
      setLoading(false);
    })();

    return () => {
      alive.current = false;
      cycleRef.current?.stop();
      progRef.current?.stop();
    };
  }, []);

  // ── Step sequence ─────────────────────────────────────────────────────────

  const steps = getSteps(form.goal || 'hyrox');
  const currentKey: StepKey = steps[step] ?? 'review';
  const progress = steps.length > 1 ? step / (steps.length - 1) : 1;

  function canContinue(): boolean {
    switch (currentKey) {
      case 'goal':          return form.goal !== '';
      case 'raceDate':      return true;
      case 'division':      return form.division !== '';
      case 'trainingDays':  return form.trainingDays !== '';
      case 'sessionLength': return form.sessionLength !== '';
      case 'availability':  return form.availability !== '';
      case 'restDays':      return form.restDays !== '';
      case 'equipment':     return form.equipment.length > 0;
      case 'runConfidence': return true;
      case 'review':        return true;
      default:              return true;
    }
  }

  function handleBack() {
    if (generating) return;
    if (step === 0) { navigation.goBack(); return; }
    setStep(s => s - 1);
  }

  function handleNext() {
    if (!canContinue()) return;
    const seq = getSteps(form.goal);
    if (step < seq.length - 1) setStep(s => s + 1);
  }

  function toggleEquipment(item: string) {
    setForm(prev => ({
      ...prev,
      equipment: prev.equipment.includes(item)
        ? prev.equipment.filter(e => e !== item)
        : [...prev.equipment, item],
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
      const patch: Record<string, any> = {
        goal:                  form.goal,
        current_training_days: form.trainingDays || null,
        session_length:        form.sessionLength || null,
        availability:          form.availability || null,
        rest_days:             form.restDays ? parseInt(form.restDays, 10) : null,
        equipment_access:      form.equipment.length > 0 ? form.equipment : null,
      };
      if (form.goal === 'hyrox') {
        patch.hyrox_division = form.division || null;
        patch.race_date      = form.raceDate  || null;
        patch.run_confidence = form.runConfidence;
      }
      await supabase.from('profiles').update(patch).eq('id', userId);

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

      // Restore backed-up programs on failure
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
                accentColor={YELLOW}
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

      case 'trainingDays':
        return (
          <View style={s.stepContent}>
            <Text style={s.label}>How many days per week will you train?</Text>
            {(['3','4','5','6'] as const).map(d =>
              renderOpt(`${d} days`, form.trainingDays === d, () => setForm(p => ({ ...p, trainingDays: d })))
            )}
          </View>
        );

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

      case 'restDays':
        return (
          <View style={s.stepContent}>
            <Text style={s.label}>How many rest days per week?</Text>
            {(['1','2','3'] as const).map(d =>
              renderOpt(d === '1' ? '1 day' : `${d} days`, form.restDays === d, () => setForm(p => ({ ...p, restDays: d })))
            )}
          </View>
        );

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

      case 'runConfidence':
        return (
          <View style={s.stepContent}>
            <Text style={s.label}>How confident are you with running?</Text>
            <Text style={s.sublabel}>1 = needs the most work{'  '}5 = your strongest asset</Text>
            <View style={s.confidenceRow}>
              {([1,2,3,4,5] as const).map(n => (
                <TouchableOpacity
                  key={n}
                  style={[s.confidenceBtn, form.runConfidence === n && s.confidenceBtnSelected]}
                  onPress={() => setForm(p => ({ ...p, runConfidence: n }))}
                >
                  <Text style={[s.confidenceBtnText, form.runConfidence === n && { color: BLACK }]}>{n}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        );

      case 'review': {
        if (!original) return null;
        const isHyrox = form.goal === 'hyrox';
        const fields: { label: string; oldVal: string; newVal: string }[] = [
          { label: 'Goal',          oldVal: fmtGoal(original.goal),           newVal: fmtGoal(form.goal) },
          ...(isHyrox ? [
            { label: 'Race Date',   oldVal: original.raceDate || 'Not set',    newVal: form.raceDate || 'Not set' },
            { label: 'Division',    oldVal: original.division || '—',          newVal: form.division || '—' },
          ] : []),
          { label: 'Training Days', oldVal: original.trainingDays ? `${original.trainingDays}/wk` : '—', newVal: form.trainingDays ? `${form.trainingDays}/wk` : '—' },
          { label: 'Session',       oldVal: fmtLen(original.sessionLength),    newVal: fmtLen(form.sessionLength) },
          { label: 'Availability',  oldVal: fmtAvail(original.availability),   newVal: fmtAvail(form.availability) },
          { label: 'Rest Days',     oldVal: fmtRestDays(original.restDays),    newVal: fmtRestDays(form.restDays) },
          { label: 'Equipment',     oldVal: original.equipment.join(', ') || 'None', newVal: form.equipment.join(', ') || 'None' },
          ...(isHyrox ? [
            { label: 'Run Confidence', oldVal: `${original.runConfidence}/5`, newVal: `${form.runConfidence}/5` },
          ] : []),
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
                    <Text style={[s.reviewLabel, changed && { color: YELLOW }]}>{f.label}</Text>
                    <View style={s.reviewValues}>
                      {changed && <Text style={s.reviewOld}>{f.oldVal}</Text>}
                      <Text style={[s.reviewNew, changed && { color: YELLOW }]}>{f.newVal}</Text>
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

  // ── Generating screen ─────────────────────────────────────────────────────

  if (generating) {
    const animWidth = progressAnim.interpolate({ inputRange: [0, 1], outputRange: [0, genBarWidth] });
    return (
      <SafeAreaView style={s.container} edges={['top', 'bottom']}>
        <Text style={s.logo}>Peak 65</Text>
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

  const isEquipmentStep = currentKey === 'equipment';
  const isReviewStep    = currentKey === 'review';
  const isRaceDateStep  = currentKey === 'raceDate';

  return (
    <SafeAreaView style={s.container} edges={['top', 'bottom']}>
      <Text style={s.logo}>Peak 65</Text>

      {/* Header: back + progress */}
      <View style={s.header}>
        <TouchableOpacity
          style={s.backBtn}
          onPress={handleBack}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Text style={s.backArrow}>←</Text>
        </TouchableOpacity>
        <View style={s.progressBarTrack}>
          <View style={[s.progressBarFill, { width: `${progress * 100}%` as any }]} />
        </View>
        <View style={s.backBtn} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        {isEquipmentStep ? (
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

        {/* Footer */}
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
  container: { flex: 1, backgroundColor: BLACK },

  logo: {
    color: YELLOW, fontSize: 36, fontWeight: '800',
    textAlign: 'center', letterSpacing: -1, paddingTop: 8, paddingBottom: 4,
  },

  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 12, gap: 12,
  },
  backBtn:        { width: 32 },
  backArrow:      { color: OFF_WHITE, fontSize: 22 },
  progressBarTrack: {
    flex: 1, height: 3, backgroundColor: '#1e1e1e', borderRadius: 2, overflow: 'hidden',
  },
  progressBarFill: { height: 3, backgroundColor: YELLOW, borderRadius: 2 },

  scrollContent: {
    flexGrow: 1, justifyContent: 'center',
    paddingHorizontal: 24, paddingBottom: 20,
  },
  multiContainer: { flex: 1, paddingHorizontal: 24, paddingTop: 4 },

  stepContent: { gap: 10 },
  label: {
    color: OFF_WHITE, fontSize: 22, fontWeight: '800',
    lineHeight: 28, marginBottom: 8, letterSpacing: -0.3,
  },
  sublabel: { color: GREY, fontSize: 13, marginTop: -4, marginBottom: 4, lineHeight: 18 },

  option: {
    backgroundColor: '#111', borderRadius: 12, paddingVertical: 16,
    paddingHorizontal: 18, borderWidth: 1, borderColor: '#222',
  },
  optionSelected:     { backgroundColor: YELLOW, borderColor: YELLOW },
  optionText:         { color: OFF_WHITE, fontSize: 16 },
  optionTextSelected: { color: BLACK, fontWeight: '700' },

  confidenceRow: { flexDirection: 'row', gap: 10, marginTop: 8 },
  confidenceBtn: {
    flex: 1, backgroundColor: '#111', borderRadius: 12,
    paddingVertical: 16, alignItems: 'center', borderWidth: 1, borderColor: '#222',
  },
  confidenceBtnSelected: { backgroundColor: YELLOW, borderColor: YELLOW },
  confidenceBtnText:     { color: OFF_WHITE, fontSize: 18, fontWeight: '700' },

  footer:   { paddingHorizontal: 24, paddingBottom: 20, paddingTop: 8, gap: 10 },
  skipBtn:  { alignItems: 'center', paddingVertical: 4 },
  skipText: { color: GREY, fontSize: 15, textDecorationLine: 'underline' },
  continueBtn: {
    backgroundColor: YELLOW, borderRadius: 14, paddingVertical: 18, alignItems: 'center',
  },
  continueBtnDisabled: { opacity: 0.35 },
  continueBtnText: { color: BLACK, fontSize: 16, fontWeight: '800', letterSpacing: 0.3 },

  // Review
  reviewCard: {
    backgroundColor: '#111', borderRadius: 14, overflow: 'hidden', marginTop: 8,
  },
  reviewRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    paddingHorizontal: 16, paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#222',
  },
  reviewLabel:  { color: GREY, fontSize: 14, fontWeight: '600', flex: 1 },
  reviewValues: { flex: 2, alignItems: 'flex-end', gap: 2 },
  reviewOld:    { color: GREY, fontSize: 12, textDecorationLine: 'line-through' },
  reviewNew:    { color: OFF_WHITE, fontSize: 14, fontWeight: '600', textAlign: 'right' },

  // Generating
  genBody: {
    flex: 1, alignItems: 'center', justifyContent: 'center', gap: 28, paddingHorizontal: 24,
  },
  genHeading: { color: OFF_WHITE, fontSize: 18, fontWeight: '600', textAlign: 'center' },
  genMsg: {
    color: YELLOW, fontSize: 26, fontWeight: '700',
    textAlign: 'center', letterSpacing: -0.3, lineHeight: 34,
  },
  retryBtn:  { paddingVertical: 8, paddingHorizontal: 16 },
  retryText: { color: YELLOW, fontSize: 15, textAlign: 'center', textDecorationLine: 'underline' },
  progressTrack: {
    height: 2, backgroundColor: '#1e1e1e', borderRadius: 1,
    marginHorizontal: 24, marginBottom: 24, overflow: 'hidden',
  },
  progressFill: { height: 2, backgroundColor: YELLOW, borderRadius: 1 },
});
