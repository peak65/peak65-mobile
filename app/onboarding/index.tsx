import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import DateTimePicker from '@react-native-community/datetimepicker';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { supabase } from '../../lib/supabase';
import type { MainStackParamList } from '../_layout';

// ─── Types ───────────────────────────────────────────────────────────────────

type Props = NativeStackScreenProps<MainStackParamList, 'Onboarding'>;

type OnboardingData = {
  first_name: string;
  last_name: string;
  age: string;
  gender: string;
  goal: 'hyrox' | 'general_fitness' | '';
  // Hyrox-specific
  hyrox_experience: string;
  hyrox_division: string;
  hyrox_goal_time: string;
  race_date: Date | null;
  station_weaknesses: string[];
  // Shared across both paths
  weekly_mileage: string;
  equipment_access: string[];
  // General fitness-specific
  current_training_days: string;
  training_history: string;
  body_weight: string;
  weight_unit: 'lbs' | 'kg';
  body_fat_range: string;
  fitness_goal: string;
  // Shared scheduling
  rest_days: string;
  rest_day_preferences: string[];
  session_length: string;
  availability: string;
};

type StepKey =
  | 'firstName' | 'lastName' | 'age' | 'gender' | 'goal'
  | 'hyroxExperience' | 'hyroxDivision' | 'hyroxGoalTime' | 'raceDate'
  | 'stationWeaknesses' | 'weeklyMileage' | 'hyroxEquipment'
  | 'generalTrainingDays' | 'trainingHistory' | 'generalEquipment'
  | 'bodyWeight' | 'bodyFatRange' | 'fitnessGoal'
  | 'restDays' | 'restDayPreferences' | 'sessionLength' | 'availability';

// ─── Step Definitions ─────────────────────────────────────────────────────────

const BASE_STEPS: StepKey[] = ['firstName', 'lastName', 'age', 'gender', 'goal'];

const HYROX_STEPS: StepKey[] = [
  'hyroxExperience', 'hyroxDivision', 'hyroxGoalTime', 'raceDate',
  'stationWeaknesses', 'trainingHistory', 'weeklyMileage', 'hyroxEquipment',
];

const GENERAL_STEPS: StepKey[] = [
  'generalTrainingDays', 'trainingHistory', 'weeklyMileage', 'generalEquipment',
  'bodyWeight', 'bodyFatRange', 'fitnessGoal',
];

const SHARED_STEPS: StepKey[] = ['restDays', 'restDayPreferences', 'sessionLength', 'availability'];

// Steps with many options that need top-aligned (not centered) scroll content
const TOP_ALIGNED_STEPS: StepKey[] = [
  'stationWeaknesses', 'hyroxEquipment', 'generalEquipment', 'bodyFatRange', 'restDayPreferences',
];

// Steps that need a bounded container so their inner ScrollView can flex to fill it
const SCROLLABLE_STEPS: StepKey[] = ['stationWeaknesses', 'hyroxEquipment', 'generalEquipment', 'bodyFatRange'];

const LOADING_MESSAGES = [
  'Analyzing your training history...',
  'Designing your assessment week...',
  'Calibrating your zones...',
  'Almost ready...',
];

function getSteps(goal: string): StepKey[] {
  if (goal === 'hyrox')           return [...BASE_STEPS, ...HYROX_STEPS,   ...SHARED_STEPS];
  if (goal === 'general_fitness') return [...BASE_STEPS, ...GENERAL_STEPS, ...SHARED_STEPS];
  return [...BASE_STEPS, ...HYROX_STEPS, ...SHARED_STEPS]; // max-length estimate before goal is picked
}

function isStepComplete(key: StepKey, d: OnboardingData): boolean {
  switch (key) {
    case 'firstName':           return d.first_name.trim().length > 0;
    case 'lastName':            return d.last_name.trim().length > 0;
    case 'age': {
      const n = parseInt(d.age, 10);
      return !isNaN(n) && n >= 13 && n <= 99;
    }
    case 'gender':              return d.gender !== '';
    case 'goal':                return d.goal !== '';
    case 'hyroxExperience':     return d.hyrox_experience !== '';
    case 'hyroxDivision':       return d.hyrox_division !== '';
    case 'hyroxGoalTime':       return d.hyrox_goal_time !== '';
    case 'raceDate':            return true; // always enabled — "skip" sets null
    case 'stationWeaknesses':   return d.station_weaknesses.length > 0;
    case 'weeklyMileage':       return d.weekly_mileage !== '';
    case 'hyroxEquipment':      return d.equipment_access.length > 0;
    case 'generalTrainingDays': return d.current_training_days !== '';
    case 'trainingHistory':     return d.training_history !== '';
    case 'generalEquipment':    return d.equipment_access.length > 0;
    case 'bodyWeight': {
      const w = parseFloat(d.body_weight);
      return !isNaN(w) && w > 0;
    }
    case 'bodyFatRange':        return d.body_fat_range !== '';
    case 'fitnessGoal':         return d.fitness_goal !== '';
    case 'restDays':            return d.rest_days !== '';
    case 'restDayPreferences':  return d.rest_day_preferences.length === parseInt(d.rest_days, 10);
    case 'sessionLength':       return d.session_length !== '';
    case 'availability':        return d.availability !== '';
    default:                    return false;
  }
}

// ─── Colours ──────────────────────────────────────────────────────────────────

const YELLOW    = '#e8ff47';
const BLACK     = '#080808';
const OFF_WHITE = '#f0ede8';
const GREY      = '#8a877f';

// ─── Initial state ────────────────────────────────────────────────────────────

const INITIAL: OnboardingData = {
  first_name: '', last_name: '', age: '', gender: '', goal: '',
  hyrox_experience: '', hyrox_division: '', hyrox_goal_time: '',
  race_date: null, station_weaknesses: [], weekly_mileage: '',
  equipment_access: [], current_training_days: '',
  training_history: '',
  body_weight: '', weight_unit: 'lbs', body_fat_range: '', fitness_goal: '',
  rest_days: '', rest_day_preferences: [], session_length: '', availability: '',
};

// ─── Fitness level derivation ─────────────────────────────────────────────────

function deriveFitnessLevel(
  trainingDays: string,
  weeklyMileage: string,
  trainingHistory: string,
): 'beginner' | 'intermediate' | 'advanced' {
  if (trainingHistory === 'Less than 6 months') return 'beginner';
  if (trainingDays === '1-2 days' && (weeklyMileage === '0' || weeklyMileage === '1-10')) return 'beginner';
  if (
    trainingHistory === '2+ years' &&
    (trainingDays === '5+ days' || weeklyMileage === '21-30' || weeklyMileage === '30+')
  ) return 'advanced';
  return 'intermediate';
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function OnboardingScreen({ navigation }: Props) {
  const [step, setStep]               = useState(0);
  const [data, setData]               = useState<OnboardingData>(INITIAL);
  const [saving, setSaving]           = useState(false);
  const [showLoading, setShowLoading] = useState(false);
  const [apiError, setApiError]       = useState(false);
  const [loadingMsgIdx, setLoadingMsgIdx] = useState(0);
  const [androidPickerOpen, setAndroidPickerOpen] = useState(false);

  const steps          = getSteps(data.goal);
  const totalSteps     = steps.length;
  const currentKey     = steps[step];
  const progress       = (step + 1) / totalSteps;
  const canContinue    = isStepComplete(currentKey, data);
  const isLastStep     = step === totalSteps - 1;
  const topAligned     = TOP_ALIGNED_STEPS.includes(currentKey);
  const isScrollableStep = SCROLLABLE_STEPS.includes(currentKey);

  // Seed race_date to 30 days from now when first entering that step
  useEffect(() => {
    if (currentKey === 'raceDate' && data.race_date === null) {
      setData(prev => ({
        ...prev,
        race_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      }));
    }
    setAndroidPickerOpen(false);
  }, [currentKey]);

  // Cycle motivational messages every 3 s while loading
  useEffect(() => {
    if (!showLoading || apiError) return;
    const id = setInterval(() => {
      setLoadingMsgIdx(i => (i + 1) % LOADING_MESSAGES.length);
    }, 3000);
    return () => clearInterval(id);
  }, [showLoading, apiError]);

  // ── Navigation ─────────────────────────────────────────────────────────────

  function handleNext() {
    if (isLastStep) {
      handleSubmit();
    } else {
      setStep(s => s + 1);
    }
  }

  function handleBack() {
    if (step > 0) setStep(s => s - 1);
  }

  function skipRaceDate() {
    setData(prev => ({ ...prev, race_date: null }));
    setStep(s => s + 1);
  }

  // ── State helpers ──────────────────────────────────────────────────────────

  function setSingle(field: keyof OnboardingData, value: string) {
    setData(prev => ({ ...prev, [field]: value }));
  }

  function toggleMulti(field: 'station_weaknesses' | 'equipment_access', value: string) {
    setData(prev => {
      const arr = prev[field] as string[];
      return {
        ...prev,
        [field]: arr.includes(value)
          ? arr.filter(v => v !== value)
          : [...arr, value],
      };
    });
  }

  function toggleRestDay(day: string) {
    const max = parseInt(data.rest_days, 10);
    setData(prev => {
      const arr = prev.rest_day_preferences;
      if (arr.includes(day)) return { ...prev, rest_day_preferences: arr.filter(d => d !== day) };
      if (arr.length >= max) return prev;
      return { ...prev, rest_day_preferences: [...arr, day] };
    });
  }

  // Clear day selections if the rest_days count changes
  useEffect(() => {
    if (data.rest_days !== '') {
      setData(prev => ({ ...prev, rest_day_preferences: [] }));
    }
  }, [data.rest_days]);

  // ── API call ───────────────────────────────────────────────────────────────

  const callGenerateAssessment = useCallback(async () => {
    setApiError(false);

    const { data: authData } = await supabase.auth.getUser();
    const userId = authData.user?.id;
    console.log('[generate-assessment] userId:', userId);
    if (!userId) { setApiError(true); return; }

    const controller = new AbortController();

    // Distinguish timeout-triggered aborts from any unexpected early abort
    let timedOut = false;
    controller.signal.addEventListener('abort', () => {
      if (!timedOut) {
        console.log('[generate-assessment] aborted early - reason:', controller.signal.reason);
      }
    });

    console.log('[generate-assessment] starting fetch...');

    // Kick off the fetch first so it is in flight before the timer is armed
    const fetchPromise = fetch('https://peak65.vercel.app/api/generate-assessment', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ userId }),
      signal: controller.signal,
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      console.log('[generate-assessment] timeout fired after 120s');
      controller.abort();
    }, 120_000);

    try {
      const res = await fetchPromise;
      clearTimeout(timeout);
      console.log('[generate-assessment] response status:', res.status);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      navigation.replace('Tabs');
    } catch (err) {
      clearTimeout(timeout);
      console.log('[generate-assessment] error:', JSON.stringify(err));
      setApiError(true);
    }
  }, [navigation]);

  async function handleRetry() {
    await callGenerateAssessment();
  }

  // ── Submit ─────────────────────────────────────────────────────────────────

  async function handleSubmit() {
    setShowLoading(true);
    setSaving(true);

    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) { setSaving(false); return; }

    const { data: upsertData, error: upsertError } = await supabase.from('profiles').upsert({
      id:                    authData.user.id,
      first_name:            data.first_name,
      last_name:             data.last_name,
      age:                   parseInt(data.age, 10),
      gender:                data.gender,
      goal:                  data.goal,
      hyrox_experience:      data.hyrox_experience      || null,
      hyrox_division:        data.hyrox_division         || null,
      hyrox_goal_time:       data.hyrox_goal_time        || null,
      race_date:             data.race_date ? data.race_date.toISOString().split('T')[0] : null,
      station_weaknesses:    data.station_weaknesses.length > 0 ? data.station_weaknesses : null,
      weekly_mileage:        data.weekly_mileage          || null,
      equipment_access:      data.equipment_access.length > 0 ? data.equipment_access : null,
      current_training_days: data.current_training_days  || null,
      training_history:      data.training_history       || null,
      fitness_level:         deriveFitnessLevel(data.current_training_days, data.weekly_mileage, data.training_history),
      body_weight:           data.body_weight ? parseFloat(data.body_weight) : null,
      weight_unit:           data.body_weight ? data.weight_unit : null,
      body_fat_range:        data.body_fat_range          || null,
      fitness_goal:          data.fitness_goal            || null,
      rest_days:             data.rest_days ? parseInt(data.rest_days, 10) : null,
      rest_day_preferences:  data.rest_day_preferences.length > 0 ? data.rest_day_preferences : null,
      session_length:        data.session_length          || null,
      availability:          data.availability            || null,
    });

    console.log('[onboarding] upsert data:', JSON.stringify(upsertData));
    console.log('[onboarding] upsert error:', JSON.stringify(upsertError));

    setSaving(false);
    await callGenerateAssessment();
  }

  // ── Render helpers ─────────────────────────────────────────────────────────

  function renderLabel(text: string) {
    return <Text style={styles.label}>{text}</Text>;
  }

  function renderTextInput(
    label: string,
    field: keyof OnboardingData,
    keyboardType: 'default' | 'number-pad' | 'decimal-pad' = 'default',
    placeholder = '',
  ) {
    const value = data[field] as string;
    const ageError =
      field === 'age' && value !== '' &&
      (parseInt(value, 10) < 13 || parseInt(value, 10) > 99);

    return (
      <View style={styles.stepContent}>
        {renderLabel(label)}
        <TextInput
          style={[styles.textInput, ageError && styles.textInputError]}
          value={value}
          onChangeText={text => setSingle(field, text)}
          keyboardType={keyboardType}
          autoCapitalize={keyboardType === 'default' ? 'words' : 'none'}
          autoFocus
          placeholder={placeholder}
          placeholderTextColor={GREY}
          selectionColor={YELLOW}
        />
        {ageError && <Text style={styles.errorText}>Age must be between 13 and 99</Text>}
      </View>
    );
  }

  function renderSingleSelect(
    label: string,
    field: keyof OnboardingData,
    options: { label: string; value: string }[],
    scrollable = false,
  ) {
    const selected = data[field] as string;
    const optionList = options.map(opt => (
      <TouchableOpacity
        key={opt.value}
        style={[styles.option, selected === opt.value && styles.optionSelected]}
        onPress={() => setSingle(field, opt.value)}
      >
        <Text style={[styles.optionText, selected === opt.value && styles.optionTextSelected]}>
          {opt.label}
        </Text>
      </TouchableOpacity>
    ));

    if (scrollable) {
      return (
        <View style={[styles.stepContent, { flex: 1 }]}>
          {renderLabel(label)}
          <View style={styles.optionsScrollOuter}>
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingBottom: 20 }}
              showsVerticalScrollIndicator={true}
              bounces={true}
              alwaysBounceVertical={true}
            >
              <View style={styles.multiOptions}>
                {optionList}
              </View>
            </ScrollView>
          </View>
        </View>
      );
    }

    return (
      <View style={styles.stepContent}>
        {renderLabel(label)}
        {optionList}
      </View>
    );
  }

  function renderMultiSelect(
    label: string,
    field: 'station_weaknesses' | 'equipment_access',
    options: string[],
  ) {
    const selected = data[field];
    return (
      <View style={[styles.stepContent, { flex: 1 }]}>
        {renderLabel(label)}
        <Text style={styles.sublabel}>Select all that apply</Text>
        <View style={styles.optionsScrollOuter}>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: 20 }}
            showsVerticalScrollIndicator={true}
            bounces={true}
            alwaysBounceVertical={true}
          >
            <View style={styles.multiOptions}>
              {options.map(opt => (
                <TouchableOpacity
                  key={opt}
                  style={[styles.option, selected.includes(opt) && styles.optionSelected]}
                  onPress={() => toggleMulti(field, opt)}
                >
                  <Text style={[styles.optionText, selected.includes(opt) && styles.optionTextSelected]}>
                    {opt}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>
        </View>
      </View>
    );
  }

  function renderDateStep() {
    const pickerDate = data.race_date ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const formattedDate = pickerDate.toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
    });

    return (
      <View style={styles.stepContent}>
        {renderLabel('When is your next Hyrox race?')}
        {Platform.OS === 'ios' ? (
          <DateTimePicker
            value={pickerDate}
            mode="date"
            display="inline"
            themeVariant="dark"
            accentColor={YELLOW}
            minimumDate={new Date()}
            onChange={(_event, date) => {
              if (date) setData(prev => ({ ...prev, race_date: date }));
            }}
            style={styles.datePicker}
          />
        ) : (
          <>
            <TouchableOpacity style={styles.option} onPress={() => setAndroidPickerOpen(true)}>
              <Text style={styles.optionText}>{formattedDate}</Text>
            </TouchableOpacity>
            {androidPickerOpen && (
              <DateTimePicker
                value={pickerDate}
                mode="date"
                display="default"
                minimumDate={new Date()}
                onChange={(_event, date) => {
                  setAndroidPickerOpen(false);
                  if (date) setData(prev => ({ ...prev, race_date: date }));
                }}
              />
            )}
          </>
        )}
      </View>
    );
  }

  function renderBodyWeightStep() {
    return (
      <View style={styles.stepContent}>
        {renderLabel('What is your body weight?')}
        <View style={styles.unitToggleRow}>
          {(['lbs', 'kg'] as const).map(unit => (
            <TouchableOpacity
              key={unit}
              style={[styles.unitBtn, data.weight_unit === unit && styles.unitBtnSelected]}
              onPress={() => setData(prev => ({ ...prev, weight_unit: unit }))}
            >
              <Text style={[styles.unitBtnText, data.weight_unit === unit && styles.unitBtnTextSelected]}>
                {unit}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <TextInput
          style={styles.textInput}
          value={data.body_weight}
          onChangeText={text => setData(prev => ({ ...prev, body_weight: text }))}
          keyboardType="decimal-pad"
          placeholder={data.weight_unit === 'lbs' ? 'e.g. 170' : 'e.g. 77'}
          placeholderTextColor={GREY}
          selectionColor={YELLOW}
          autoFocus
        />
      </View>
    );
  }

  // ── Step dispatcher ────────────────────────────────────────────────────────

  function renderCurrentStep() {
    switch (currentKey) {
      case 'firstName':
        return renderTextInput("What's your first name?", 'first_name');

      case 'lastName':
        return renderTextInput("What's your last name?", 'last_name');

      case 'age':
        return renderTextInput('How old are you?', 'age', 'number-pad');

      case 'gender':
        return renderSingleSelect('What is your gender?', 'gender', [
          { label: 'Male',   value: 'Male' },
          { label: 'Female', value: 'Female' },
        ]);

      case 'goal':
        return renderSingleSelect("What's your main goal?", 'goal', [
          { label: 'Train for Hyrox', value: 'hyrox' },
          { label: 'General Fitness', value: 'general_fitness' },
        ]);

      // ── Hyrox path ──────────────────────────────────────────────────────────

      case 'hyroxExperience':
        return renderSingleSelect("What's your current Hyrox level?", 'hyrox_experience', [
          { label: 'Never done a Hyrox', value: 'never'    },
          { label: 'Over 1:30',          value: 'over_130' },
          { label: '1:15 – 1:30',        value: '115_130'  },
          { label: '1:05 – 1:15',        value: '105_115'  },
          { label: 'Sub 1:05',           value: 'sub_105'  },
        ]);

      case 'hyroxDivision': {
        const label = data.hyrox_experience === 'never'
          ? 'Which division do you want to train for?'
          : 'Which division do you compete in?';
        return renderSingleSelect(label, 'hyrox_division', [
          { label: 'Men Open',      value: 'Men Open' },
          { label: 'Men Pro',       value: 'Men Pro' },
          { label: 'Women Open',    value: 'Women Open' },
          { label: 'Women Pro',     value: 'Women Pro' },
          { label: 'Mixed Doubles', value: 'Mixed Doubles' },
        ]);
      }

      case 'hyroxGoalTime':
        return renderSingleSelect("What's your goal finish time?", 'hyrox_goal_time', [
          { label: 'Sub 1:05 (Elite)',           value: 'Sub 1:05 (Elite)' },
          { label: 'Sub 1:15 (Competitive)',     value: 'Sub 1:15 (Competitive)' },
          { label: 'Sub 1:30 (Strong Finisher)', value: 'Sub 1:30 (Strong Finisher)' },
          { label: 'Just finish strong',         value: 'Just finish strong' },
        ]);

      case 'raceDate':
        return renderDateStep();

      case 'stationWeaknesses':
        return renderMultiSelect(
          'Which Hyrox stations are your biggest weakness?',
          'station_weaknesses',
          ['Ski Erg', 'Row Erg', 'Sled Push', 'Sled Pull',
           'Burpee Broad Jumps', 'Farmers Carry', 'Sandbag Lunges', 'Wall Balls', 'Unsure'],
        );

      case 'hyroxEquipment':
        return renderMultiSelect(
          'What equipment do you have access to?',
          'equipment_access',
          ['Barbell + Rack', 'Dumbbells', 'Kettlebells', 'Pull-up Bar',
           'Ski Erg', 'Row Erg', 'Sled', 'Assault Bike', 'Full Gym Access'],
        );

      // ── General Fitness path ─────────────────────────────────────────────────

      case 'generalTrainingDays':
        return renderSingleSelect(
          'How many days per week do you currently train?',
          'current_training_days',
          [
            { label: '1-2 days', value: '1-2 days' },
            { label: '3-4 days', value: '3-4 days' },
            { label: '5+ days',  value: '5+ days' },
          ],
        );

      case 'trainingHistory':
        return renderSingleSelect(
          'How long have you been training consistently?',
          'training_history',
          [
            { label: 'Less than 6 months', value: 'Less than 6 months' },
            { label: '6 months – 2 years', value: '6 months – 2 years' },
            { label: '2+ years',           value: '2+ years' },
          ],
        );

      case 'generalEquipment':
        return renderMultiSelect(
          'What equipment do you have access to?',
          'equipment_access',
          ['Barbell + Rack', 'Dumbbells', 'Kettlebells', 'Pull-up Bar',
           'Ski Erg', 'Row Erg', 'Assault Bike', 'Full Gym Access', 'No Equipment'],
        );

      case 'bodyWeight':
        return renderBodyWeightStep();

      case 'bodyFatRange':
        return renderSingleSelect(
          'What is your current body fat %?',
          'body_fat_range',
          [
            { label: 'Under 10%',           value: 'Under 10%' },
            { label: '10–15%',              value: '10-15%' },
            { label: '15–20%',              value: '15-20%' },
            { label: '20–25%',              value: '20-25%' },
            { label: '25–30%',              value: '25-30%' },
            { label: '30%+',               value: '30%+' },
            { label: "Unsure / I don't know", value: 'unsure' },
          ],
          true,
        );

      case 'fitnessGoal':
        return renderSingleSelect('What is your primary goal?', 'fitness_goal', [
          { label: 'Look better',          value: 'look_better' },
          { label: 'Get stronger',         value: 'get_stronger' },
          { label: 'Improve performance',  value: 'improve_performance' },
          { label: 'All-around fitness',   value: 'all_around' },
        ]);

      // ── Shared (both paths) ──────────────────────────────────────────────────

      case 'weeklyMileage':
        return renderSingleSelect(
          'How many miles per week do you currently run?',
          'weekly_mileage',
          [
            { label: '0 miles',     value: '0' },
            { label: '1–10 miles',  value: '1-10' },
            { label: '11–20 miles', value: '11-20' },
            { label: '21–30 miles', value: '21-30' },
            { label: '30+ miles',   value: '30+' },
          ],
        );

      // ── Shared scheduling ────────────────────────────────────────────────────

      case 'restDays':
        return renderSingleSelect('How many rest days per week do you want?', 'rest_days', [
          { label: '1', value: '1' },
          { label: '2', value: '2' },
          { label: '3', value: '3' },
        ]);

      case 'restDayPreferences': {
        const max = parseInt(data.rest_days, 10);
        const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        return (
          <View style={styles.stepContent}>
            {renderLabel(`Which day${max > 1 ? 's' : ''} do you want to rest?`)}
            <Text style={styles.sublabel}>
              {`Choose ${max} — ${data.rest_day_preferences.length} of ${max} selected`}
            </Text>
            {DAYS.map(day => (
              <TouchableOpacity
                key={day}
                style={[styles.option, data.rest_day_preferences.includes(day) && styles.optionSelected]}
                onPress={() => toggleRestDay(day)}
              >
                <Text style={[styles.optionText, data.rest_day_preferences.includes(day) && styles.optionTextSelected]}>
                  {day}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        );
      }

      case 'sessionLength':
        return renderSingleSelect('How much time do you have per session?', 'session_length', [
          { label: 'About 1 hour',      value: '60' },
          { label: 'About 1.5–2 hours', value: '90' },
        ]);

      case 'availability':
        return renderSingleSelect('When are you available to train?', 'availability', [
          { label: 'Once a day',            value: 'once' },
          { label: 'Twice a day (AM + PM)', value: 'twice' },
        ]);

      default:
        return null;
    }
  }

  // ── Loading screen ─────────────────────────────────────────────────────────

  if (showLoading) {
    return (
      <SafeAreaView style={styles.loadingScreen} edges={['top', 'bottom']}>
        <Text style={styles.logo}>Peak 65</Text>
        <View style={styles.loadingBody}>
          {!apiError && <ActivityIndicator size="large" color={YELLOW} style={{ marginBottom: 28 }} />}
          <Text style={styles.loadingTitle}>Building your program...</Text>
          {apiError ? (
            <TouchableOpacity onPress={handleRetry} style={styles.retryBtn}>
              <Text style={styles.retryText}>Something went wrong. Tap to try again.</Text>
            </TouchableOpacity>
          ) : (
            <Text style={styles.loadingSubtext}>{LOADING_MESSAGES[loadingMsgIdx]}</Text>
          )}
        </View>
      </SafeAreaView>
    );
  }

  // ── Main render ────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {/* Logo */}
      <Text style={styles.logo}>Peak 65</Text>

      {/* Header: back arrow + progress bar */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={handleBack}
          disabled={step === 0}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          {step > 0 && <Text style={styles.backArrow}>←</Text>}
        </TouchableOpacity>

        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
        </View>

        <View style={styles.backBtn} />
      </View>

      {/* Question area — bounded View for multi-select, ScrollView for everything else */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {isScrollableStep ? (
          <View style={styles.multiSelectContainer}>
            {renderCurrentStep()}
          </View>
        ) : (
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={[
              styles.scrollContent,
              topAligned && styles.scrollContentTop,
            ]}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {renderCurrentStep()}
          </ScrollView>
        )}

        {/* Footer */}
        <View style={styles.footer}>
          {currentKey === 'raceDate' && (
            <TouchableOpacity style={styles.skipBtn} onPress={skipRaceDate}>
              <Text style={styles.skipText}>I don't have a race yet</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.continueBtn, !canContinue && styles.continueBtnDisabled]}
            onPress={handleNext}
            disabled={!canContinue || saving}
          >
            <Text style={styles.continueBtnText}>
              {isLastStep ? 'Finish' : 'Continue'}
            </Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BLACK,
  },

  // Logo
  logo: {
    color: YELLOW,
    fontSize: 36,
    fontWeight: '800',
    textAlign: 'center',
    letterSpacing: -1,
    paddingTop: 8,
    paddingBottom: 4,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  backBtn: {
    width: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backArrow: {
    color: OFF_WHITE,
    fontSize: 22,
  },
  progressTrack: {
    flex: 1,
    height: 4,
    backgroundColor: '#1e1e1e',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: YELLOW,
    borderRadius: 2,
  },

  // Content
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 20,
  },
  // For steps with many options — start from top, don't center
  scrollContentTop: {
    justifyContent: 'flex-start',
    paddingTop: 8,
  },
  stepContent: {
    gap: 10,
  },
  label: {
    color: OFF_WHITE,
    fontSize: 26,
    fontWeight: '700',
    lineHeight: 34,
    marginBottom: 10,
  },
  sublabel: {
    color: GREY,
    fontSize: 14,
    marginTop: -6,
  },

  // Text input
  textInput: {
    backgroundColor: '#111',
    borderWidth: 1,
    borderColor: '#262626',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: OFF_WHITE,
    fontSize: 18,
  },
  textInputError: {
    borderColor: '#ff5c5c',
  },
  errorText: {
    color: '#ff5c5c',
    fontSize: 13,
  },

  // Options (single + multi select)
  option: {
    backgroundColor: '#111',
    borderWidth: 1,
    borderColor: '#262626',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 15,
  },
  optionSelected: {
    backgroundColor: YELLOW,
    borderColor: YELLOW,
  },
  optionText: {
    color: OFF_WHITE,
    fontSize: 16,
    lineHeight: 22,
  },
  optionTextSelected: {
    color: BLACK,
    fontWeight: '600',
  },

  // Multi-select bounded container (replaces outer ScrollView for these steps)
  multiSelectContainer: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 4,
  },

  // Outer wrapper for scrollable option lists — flex: 1 so inner ScrollView can fill it
  optionsScrollOuter: {
    flex: 1,
    overflow: 'hidden',
  },
  multiOptions: {
    gap: 10,
  },

  // Body weight unit toggle
  unitToggleRow: {
    flexDirection: 'row',
    gap: 10,
  },
  unitBtn: {
    flex: 1,
    backgroundColor: '#111',
    borderWidth: 1,
    borderColor: '#262626',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  unitBtnSelected: {
    backgroundColor: YELLOW,
    borderColor: YELLOW,
  },
  unitBtnText: {
    color: OFF_WHITE,
    fontSize: 16,
    fontWeight: '600',
  },
  unitBtnTextSelected: {
    color: BLACK,
  },

  // Date picker (iOS inline)
  datePicker: {
    backgroundColor: BLACK,
    marginTop: 4,
  },

  // Footer
  footer: {
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 16,
    gap: 8,
  },
  skipBtn: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  skipText: {
    color: GREY,
    fontSize: 15,
    textDecorationLine: 'underline',
  },
  continueBtn: {
    backgroundColor: YELLOW,
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
  },
  continueBtnDisabled: {
    opacity: 0.4,
  },
  continueBtnText: {
    color: BLACK,
    fontSize: 16,
    fontWeight: '700',
  },

  // Loading screen
  loadingScreen: {
    flex: 1,
    backgroundColor: BLACK,
    paddingHorizontal: 24,
  },
  loadingBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingTitle: {
    color: OFF_WHITE,
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
  },
  loadingSubtext: {
    color: GREY,
    fontSize: 15,
    textAlign: 'center',
  },
  retryBtn: {
    marginTop: 8,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  retryText: {
    color: YELLOW,
    fontSize: 15,
    textAlign: 'center',
    textDecorationLine: 'underline',
  },
});
