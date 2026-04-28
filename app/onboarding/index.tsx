import React, { useState, useEffect } from 'react';
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
  hyrox_experience: string;
  hyrox_division: string;
  hyrox_goal_time: string;
  race_date: Date | null;
  station_weaknesses: string[];
  run_confidence: string;
  equipment_access: string[];
  experience_level: string;
  rest_days: string;
  session_length: string;
  availability: string;
};

type StepKey =
  | 'firstName' | 'lastName' | 'age' | 'gender' | 'goal'
  | 'hyroxExperience' | 'hyroxDivision' | 'hyroxGoalTime' | 'raceDate'
  | 'stationWeaknesses' | 'runConfidence' | 'hyroxEquipment'
  | 'experienceLevel' | 'generalEquipment'
  | 'restDays' | 'sessionLength' | 'availability';

// ─── Step Definitions ─────────────────────────────────────────────────────────

const BASE_STEPS: StepKey[] = ['firstName', 'lastName', 'age', 'gender', 'goal'];
const HYROX_STEPS: StepKey[] = [
  'hyroxExperience', 'hyroxDivision', 'hyroxGoalTime', 'raceDate',
  'stationWeaknesses', 'runConfidence', 'hyroxEquipment',
];
const GENERAL_STEPS: StepKey[] = ['experienceLevel', 'generalEquipment'];
const SHARED_STEPS: StepKey[] = ['restDays', 'sessionLength', 'availability'];

function getSteps(goal: string): StepKey[] {
  if (goal === 'hyrox') return [...BASE_STEPS, ...HYROX_STEPS, ...SHARED_STEPS];
  if (goal === 'general_fitness') return [...BASE_STEPS, ...GENERAL_STEPS, ...SHARED_STEPS];
  return [...BASE_STEPS, ...HYROX_STEPS, ...SHARED_STEPS]; // show max length before goal chosen
}

function isStepComplete(key: StepKey, d: OnboardingData): boolean {
  switch (key) {
    case 'firstName':          return d.first_name.trim().length > 0;
    case 'lastName':           return d.last_name.trim().length > 0;
    case 'age': {
      const n = parseInt(d.age, 10);
      return !isNaN(n) && n >= 13 && n <= 99;
    }
    case 'gender':             return d.gender !== '';
    case 'goal':               return d.goal !== '';
    case 'hyroxExperience':    return d.hyrox_experience !== '';
    case 'hyroxDivision':      return d.hyrox_division !== '';
    case 'hyroxGoalTime':      return d.hyrox_goal_time !== '';
    case 'raceDate':           return true; // always enabled — "skip" clears date
    case 'stationWeaknesses':  return d.station_weaknesses.length > 0;
    case 'runConfidence':      return d.run_confidence !== '';
    case 'hyroxEquipment':     return d.equipment_access.length > 0;
    case 'experienceLevel':    return d.experience_level !== '';
    case 'generalEquipment':   return d.equipment_access.length > 0;
    case 'restDays':           return d.rest_days !== '';
    case 'sessionLength':      return d.session_length !== '';
    case 'availability':       return d.availability !== '';
    default:                   return false;
  }
}

// ─── Colours ──────────────────────────────────────────────────────────────────

const YELLOW   = '#e8ff47';
const BLACK    = '#080808';
const OFF_WHITE = '#f0ede8';
const GREY     = '#8a877f';

// ─── Component ───────────────────────────────────────────────────────────────

const INITIAL: OnboardingData = {
  first_name: '', last_name: '', age: '', gender: '', goal: '',
  hyrox_experience: '', hyrox_division: '', hyrox_goal_time: '',
  race_date: null, station_weaknesses: [], run_confidence: '',
  equipment_access: [], experience_level: '',
  rest_days: '', session_length: '', availability: '',
};

export default function OnboardingScreen({ navigation }: Props) {
  const [step, setStep]             = useState(0);
  const [data, setData]             = useState<OnboardingData>(INITIAL);
  const [saving, setSaving]         = useState(false);
  const [showLoading, setShowLoading] = useState(false);
  // Android needs an explicit toggle; iOS shows date picker inline
  const [androidPickerOpen, setAndroidPickerOpen] = useState(false);

  const steps         = getSteps(data.goal);
  const totalSteps    = steps.length;
  const currentKey    = steps[step];
  const progress      = (step + 1) / totalSteps;
  const canContinue   = isStepComplete(currentKey, data);
  const isLastStep    = step === totalSteps - 1;

  // Seed race_date to 30 days from now when the step is first entered
  useEffect(() => {
    if (currentKey === 'raceDate' && data.race_date === null) {
      setData(prev => ({
        ...prev,
        race_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      }));
    }
    // Reset Android picker state when moving to a new step
    setAndroidPickerOpen(false);
  }, [currentKey]);

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

  // ── Submit ─────────────────────────────────────────────────────────────────

  async function handleSubmit() {
    setShowLoading(true);
    setSaving(true);

    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) { setSaving(false); return; }

    await supabase.from('profiles').upsert({
      id:                 authData.user.id,
      first_name:         data.first_name,
      last_name:          data.last_name,
      age:                parseInt(data.age, 10),
      gender:             data.gender,
      goal:               data.goal,
      hyrox_experience:   data.hyrox_experience   || null,
      hyrox_division:     data.hyrox_division      || null,
      hyrox_goal_time:    data.hyrox_goal_time     || null,
      race_date:          data.race_date ? data.race_date.toISOString().split('T')[0] : null,
      station_weaknesses: data.station_weaknesses.length > 0 ? data.station_weaknesses : null,
      run_confidence:     data.run_confidence      || null,
      equipment_access:   data.equipment_access.length > 0 ? data.equipment_access : null,
      experience_level:   data.experience_level    || null,
      rest_days:          data.rest_days ? parseInt(data.rest_days, 10) : null,
      session_length:     data.session_length      || null,
      availability:       data.availability        || null,
    });

    setSaving(false);
    // TODO: Replace navigation below with AI program generation call once ready.
    navigation.replace('Dashboard');
  }

  // ── Render helpers ─────────────────────────────────────────────────────────

  function renderLabel(text: string) {
    return <Text style={styles.label}>{text}</Text>;
  }

  function renderTextInput(
    label: string,
    field: keyof OnboardingData,
    keyboardType: 'default' | 'number-pad' = 'default',
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
          placeholderTextColor={GREY}
          selectionColor={YELLOW}
        />
        {ageError && (
          <Text style={styles.errorText}>Age must be between 13 and 99</Text>
        )}
      </View>
    );
  }

  function renderSingleSelect(
    label: string,
    field: keyof OnboardingData,
    options: { label: string; value: string }[],
  ) {
    const selected = data[field] as string;
    return (
      <View style={styles.stepContent}>
        {renderLabel(label)}
        {options.map(opt => (
          <TouchableOpacity
            key={opt.value}
            style={[styles.option, selected === opt.value && styles.optionSelected]}
            onPress={() => setSingle(field, opt.value)}
          >
            <Text style={[styles.optionText, selected === opt.value && styles.optionTextSelected]}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
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
      <View style={styles.stepContent}>
        {renderLabel(label)}
        <Text style={styles.sublabel}>Select all that apply</Text>
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
            <TouchableOpacity
              style={styles.option}
              onPress={() => setAndroidPickerOpen(true)}
            >
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
          { label: 'Male',              value: 'Male' },
          { label: 'Female',            value: 'Female' },
          { label: 'Prefer not to say', value: 'Prefer not to say' },
        ]);

      case 'goal':
        return renderSingleSelect("What's your main goal?", 'goal', [
          { label: 'Train for Hyrox', value: 'hyrox' },
          { label: 'General Fitness', value: 'general_fitness' },
        ]);

      case 'hyroxExperience':
        return renderSingleSelect("What's your current Hyrox level?", 'hyrox_experience', [
          { label: 'Never done a Hyrox', value: 'Never done a Hyrox' },
          { label: 'Under 1:30',         value: 'Under 1:30' },
          { label: '1:30 - 1:15',        value: '1:30 - 1:15' },
          { label: '1:15 - 1:05',        value: '1:15 - 1:05' },
          { label: 'Sub 1:05',           value: 'Sub 1:05' },
        ]);

      case 'hyroxDivision': {
        const label = data.hyrox_experience === 'Never done a Hyrox'
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
          { label: 'Sub 1:05 (Elite)',          value: 'Sub 1:05 (Elite)' },
          { label: 'Sub 1:15 (Competitive)',    value: 'Sub 1:15 (Competitive)' },
          { label: 'Sub 1:30 (Strong Finisher)', value: 'Sub 1:30 (Strong Finisher)' },
          { label: 'Just finish strong',        value: 'Just finish strong' },
        ]);

      case 'raceDate':
        return renderDateStep();

      case 'stationWeaknesses':
        return renderMultiSelect(
          'Which Hyrox stations are your biggest weakness?',
          'station_weaknesses',
          ['Ski Erg', 'Row Erg', 'Sled Push', 'Sled Pull',
           'Burpee Broad Jumps', 'Farmers Carry', 'Sandbag Lunges', 'Wall Balls', 'Running'],
        );

      case 'runConfidence':
        return renderSingleSelect('How do you feel about your running?', 'run_confidence', [
          { label: 'Running is my strength', value: 'Running is my strength' },
          { label: 'Running is average',     value: 'Running is average' },
          { label: 'Running is my weakness', value: 'Running is my weakness' },
        ]);

      case 'hyroxEquipment':
        return renderMultiSelect(
          'What equipment do you have access to?',
          'equipment_access',
          ['Barbell + Rack', 'Dumbbells', 'Kettlebells', 'Pull-up Bar',
           'Ski Erg', 'Row Erg', 'Sled', 'Assault Bike', 'Full Gym Access'],
        );

      case 'experienceLevel':
        return renderSingleSelect(
          'How would you describe your training experience?',
          'experience_level',
          [
            { label: 'Beginner (new to structured training)',               value: 'Beginner' },
            { label: 'Intermediate (1-2 years consistent training)',        value: 'Intermediate' },
            { label: 'Advanced (3+ years, comfortable with complex movements)', value: 'Advanced' },
          ],
        );

      case 'generalEquipment':
        return renderMultiSelect(
          'What equipment do you have access to?',
          'equipment_access',
          ['Barbell + Rack', 'Dumbbells', 'Kettlebells', 'Pull-up Bar',
           'Assault Bike', 'Full Gym Access', 'No Equipment'],
        );

      case 'restDays':
        return renderSingleSelect('How many rest days per week do you want?', 'rest_days', [
          { label: '1', value: '1' },
          { label: '2', value: '2' },
          { label: '3', value: '3' },
        ]);

      case 'sessionLength':
        return renderSingleSelect('How much time do you have per session?', 'session_length', [
          { label: '60 min', value: '60 min' },
          { label: '90 min', value: '90 min' },
        ]);

      case 'availability':
        return renderSingleSelect('When are you available to train?', 'availability', [
          { label: 'Mornings (AM)',   value: 'Mornings (AM)' },
          { label: 'Evenings (PM)',   value: 'Evenings (PM)' },
          { label: 'Both (AM + PM)', value: 'Both (AM + PM)' },
        ]);

      default:
        return null;
    }
  }

  // ── Loading screen ─────────────────────────────────────────────────────────

  if (showLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={YELLOW} />
        <Text style={styles.loadingText}>Building your program...</Text>
      </View>
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

        {/* Spacer mirrors the back button so the bar stays centred */}
        <View style={styles.backBtn} />
      </View>

      {/* Scrollable question area */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {renderCurrentStep()}
        </ScrollView>

        {/* Footer: optional skip + Continue */}
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
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 12,
  },
  stepContent: {
    flex: 1,
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

  // Options
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
    backgroundColor: '#1e1e1e',
  },
  continueBtnText: {
    color: BLACK,
    fontSize: 16,
    fontWeight: '700',
  },

  // Loading
  loadingContainer: {
    flex: 1,
    backgroundColor: BLACK,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
  },
  loadingText: {
    color: OFF_WHITE,
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
});
