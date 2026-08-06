import React, { useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  Platform, KeyboardAvoidingView, Modal, Alert, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import DateTimePicker from '@react-native-community/datetimepicker';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Feather } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { getWhoopAuthUrl } from '../../lib/whoopApi';
import type { MainStackParamList } from '../_layout';
import { Colors } from '../../lib/theme';
import { Logo } from '../../components/Logo';

// Setup flow for Pinnacle (tier 'elite') athletes. Their coach builds the
// program by hand, so this collects only what the coach needs up front —
// birthday, upcoming races, and whether there's a Whoop to read from — then
// hands off to the Waiting screen.

type Props = NativeStackScreenProps<MainStackParamList, 'PinnacleSetup'>;

// ─── Constants ────────────────────────────────────────────────────────────────

const DOB_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DOB_DAYS = Array.from({ length: 31 }, (_, i) => String(i + 1));
const DOB_YEARS = Array.from({ length: 87 }, (_, i) => String(2013 - i));

const TOTAL_STEPS = 4;
const DEFAULT_RACE_OFFSET_MS = 90 * 24 * 60 * 60 * 1000;

type Race = { key: string; race_date: string; event_name: string; event_city: string };

// Local-time YYYY-MM-DD. Deliberately not toISOString().split('T')[0] — that
// converts to UTC first, which rolls a late-evening date forward a day for
// anyone west of Greenwich.
function toDateString(d: Date): string {
  const year  = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day   = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatRaceDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
}

// ─── DrumRollPicker (mirrors the one in onboarding/index.tsx) ─────────────────

const DRUM_ITEM_H = 44;
const DRUM_H      = DRUM_ITEM_H * 3;
const DRUM_PAD    = DRUM_ITEM_H * 1;

function DrumRollPicker({ items, selectedIndex, onChange }: { items: string[]; selectedIndex: number; onChange: (i: number) => void }) {
  const listRef = useRef<ScrollView>(null);
  const [hlIdx, setHlIdx] = useState(selectedIndex);
  React.useEffect(() => {
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

// ─── Component ────────────────────────────────────────────────────────────────

export default function PinnacleSetupScreen({ navigation }: Props) {
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);

  // Step 2 — birthday
  const [dobMonthIdx, setDobMonthIdx] = useState(0);
  const [dobDayIdx, setDobDayIdx]     = useState(0);
  const [dobYearIdx, setDobYearIdx]   = useState(23); // 1990
  const [dateOfBirth, setDateOfBirth] = useState('1990-01-01');
  const [dobTouched, setDobTouched]   = useState(false);

  // Step 3 — races
  const [races, setRaces] = useState<Race[]>([]);
  const raceSeq = useRef(0);
  const [datePickerIdx, setDatePickerIdx] = useState<number | null>(null);
  const [tempDate, setTempDate] = useState<Date>(new Date(Date.now() + DEFAULT_RACE_OFFSET_MS));

  // Step 4 — Whoop
  const [hasWhoop, setHasWhoop] = useState<'yes' | 'no' | null>(null);
  const [whoopLaunching, setWhoopLaunching] = useState(false);

  const progress = (step + 1) / TOTAL_STEPS;

  // ── Step 2 helpers ─────────────────────────────────────────────────────────

  function handleDOBChange(mIdx: number, dIdx: number, yIdx: number) {
    const month = String(mIdx + 1).padStart(2, '0');
    const day   = String(dIdx + 1).padStart(2, '0');
    const year  = DOB_YEARS[yIdx];
    setDateOfBirth(`${year}-${month}-${day}`);
    setDobTouched(true);
  }

  // ── Step 3 helpers ─────────────────────────────────────────────────────────

  function addRace() {
    raceSeq.current += 1;
    setRaces(prev => [...prev, { key: `race-${raceSeq.current}`, race_date: '', event_name: '', event_city: '' }]);
  }

  function removeRace(idx: number) {
    setRaces(prev => prev.filter((_, i) => i !== idx));
  }

  function updateRace(idx: number, patch: Partial<Race>) {
    setRaces(prev => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  function openDatePicker(idx: number) {
    const existing = races[idx]?.race_date;
    if (existing) {
      const [y, m, d] = existing.split('-').map(Number);
      setTempDate(new Date(y, m - 1, d));
    } else {
      setTempDate(new Date(Date.now() + DEFAULT_RACE_OFFSET_MS));
    }
    setDatePickerIdx(idx);
  }

  function commitDate(d: Date) {
    if (datePickerIdx !== null) updateRace(datePickerIdx, { race_date: toDateString(d) });
    setDatePickerIdx(null);
  }

  // ── Step 4 helpers ─────────────────────────────────────────────────────────

  async function connectWhoop() {
    setWhoopLaunching(true);
    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user?.id;
    if (!userId) {
      Alert.alert('Error', 'Could not start Whoop connection. Please sign in again.');
      setWhoopLaunching(false);
      return;
    }
    // state carries the userId; the backend redirect performs the code exchange
    // and stores tokens server-side. We don't wait on the round-trip — the
    // athlete can finish setup either way.
    const url = getWhoopAuthUrl(userId);
    Linking.openURL(url).catch(e => {
      console.log('[pinnacle-setup] whoop openURL error:', e);
      Alert.alert('Error', 'Could not open Whoop authorization page.');
    }).finally(() => setWhoopLaunching(false));
  }

  // ── Finish ─────────────────────────────────────────────────────────────────

  async function handleFinish() {
    if (saving) return;
    setSaving(true);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      Alert.alert('Something went wrong', 'We could not confirm your account. Please sign in again.');
      setSaving(false);
      return;
    }

    const age = Math.floor((Date.now() - new Date(dateOfBirth).getTime()) / (365.25 * 24 * 60 * 60 * 1000));

    // 1. Profile — must succeed before we go anywhere.
    const { error: profileError } = await supabase
      .from('profiles')
      .update({
        date_of_birth:       dateOfBirth,
        age,
        program_status:      'awaiting_coach',
        onboarding_complete: true,
      })
      .eq('id', user.id);

    if (profileError) {
      console.error('[pinnacle-setup] profile update failed:', profileError.message);
      Alert.alert('Something went wrong', 'We could not save your details. Please try again.');
      setSaving(false);
      return;
    }

    // 2. Races — optional. A coach can add these later, so a failure here is
    // surfaced but never blocks an athlete whose profile already saved.
    const rows = races
      .filter(r => r.race_date !== '')
      .map(r => ({
        user_id:    user.id,
        race_date:  r.race_date,
        event_name: r.event_name.trim() || null,
        event_city: r.event_city.trim() || null,
        status:     'upcoming',
      }));

    let racesSaved = true;
    if (rows.length > 0) {
      const { error: racesError } = await supabase.from('races').insert(rows);
      if (racesError) {
        racesSaved = false;
        console.error('[pinnacle-setup] races insert failed:', racesError.message);
        Alert.alert('Races not saved', 'Your details are saved, but we could not save your races. Your coach can add them for you.');
      }
    }

    // 3. Mirror profiles.race_date to the soonest upcoming race, so the coach
    // chip and the backend keep working off the singular column. Only mirrors
    // races that actually made it into the table.
    if (racesSaved && rows.length > 0) {
      const today = toDateString(new Date());
      const soonest = rows
        .map(r => r.race_date)
        .filter(d => d >= today)
        .sort()[0];

      if (soonest) {
        const { error: mirrorError } = await supabase
          .from('profiles')
          .update({ race_date: soonest })
          .eq('id', user.id);
        if (mirrorError) console.log('[pinnacle-setup] race_date mirror failed:', mirrorError.message);
      }
    }

    // Into the main app, not a dead-end waiting screen — they can message their
    // coach and connect a wearable while the program is built. Matches what the
    // gate resolves to on a cold start.
    navigation.replace('Tabs');
  }

  // ── Step renders ───────────────────────────────────────────────────────────

  function renderWelcome() {
    return (
      <View style={styles.stepContent}>
        <Text style={styles.label}>Welcome to Peak 65.</Text>
        <Text style={styles.sublabel}>
          Your coach will build your program personally. Just a couple of quick things first.
        </Text>
      </View>
    );
  }

  function renderBirthday() {
    return (
      <View style={styles.stepContent}>
        <Text style={styles.label}>When's your birthday?</Text>
        <Text style={styles.sublabel}>Your coach uses this to set your training zones.</Text>
        <View style={{ gap: 4, marginTop: 12 }}>
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

  function renderRaces() {
    return (
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 24, paddingVertical: 12, paddingBottom: 32 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.label}>Any races coming up?</Text>
        <Text style={styles.sublabel}>
          Add what you know. Your coach works backwards from race day — you can add more later.
        </Text>

        <View style={{ gap: 12, marginTop: 20 }}>
          {races.map((race, idx) => (
            <View key={race.key} style={styles.raceCard}>
              <View style={styles.raceCardHeader}>
                <Text style={styles.sectionHeader}>RACE {idx + 1}</Text>
                <TouchableOpacity onPress={() => removeRace(idx)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Feather name="x" size={18} color={Colors.textSecondary} />
                </TouchableOpacity>
              </View>

              <TouchableOpacity style={styles.option} onPress={() => openDatePicker(idx)}>
                <Text style={race.race_date ? styles.optionTextSelected : styles.optionPlaceholder}>
                  {race.race_date ? formatRaceDate(race.race_date) : 'Select race date'}
                </Text>
              </TouchableOpacity>

              <TextInput
                style={styles.textInput}
                placeholder="Event name (optional)"
                placeholderTextColor={Colors.textSecondary}
                value={race.event_name}
                onChangeText={t => updateRace(idx, { event_name: t })}
                selectionColor={Colors.accent}
              />
              <TextInput
                style={styles.textInput}
                placeholder="City (optional)"
                placeholderTextColor={Colors.textSecondary}
                value={race.event_city}
                onChangeText={t => updateRace(idx, { event_city: t })}
                selectionColor={Colors.accent}
              />
            </View>
          ))}

          <TouchableOpacity style={styles.addRaceBtn} onPress={addRace}>
            <Feather name="plus" size={16} color={Colors.accent} />
            <Text style={styles.addRaceText}>
              {races.length === 0 ? 'Add a race' : 'Add another race'}
            </Text>
          </TouchableOpacity>

          {races.length === 0 && (
            <Text style={styles.helperNote}>
              No races booked yet? That's fine — skip this and your coach will add them when you do.
            </Text>
          )}
        </View>
      </ScrollView>
    );
  }

  function renderWhoop() {
    return (
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 24, paddingVertical: 12, paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.label}>Do you have a Whoop?</Text>
        <Text style={styles.sublabel}>It's the wearable we support right now.</Text>

        <View style={[styles.twoCardRow, { marginTop: 20 }]}>
          {([{ l: 'Yes', v: 'yes' }, { l: 'No', v: 'no' }] as const).map(o => (
            <TouchableOpacity
              key={o.v}
              style={[styles.halfCard, hasWhoop === o.v && styles.halfCardSelected]}
              onPress={() => setHasWhoop(o.v)}
            >
              <Text style={[styles.halfCardTitle, hasWhoop === o.v && { color: Colors.accent }]}>{o.l}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {hasWhoop === 'yes' && (
          <View style={{ gap: 12, marginTop: 20 }}>
            <View style={styles.infoCard}>
              <Text style={styles.infoText}>
                Connecting it lets your coach see your recovery, sleep, and strain to fine-tune your training.
              </Text>
            </View>
            <TouchableOpacity
              style={[styles.secondaryBtn, whoopLaunching && styles.continueBtnDisabled]}
              onPress={connectWhoop}
              disabled={whoopLaunching}
            >
              <Text style={styles.secondaryBtnText}>
                {whoopLaunching ? 'Opening Whoop…' : 'Connect Whoop'}
              </Text>
            </TouchableOpacity>
            <Text style={styles.helperNote}>
              You'll be sent to Whoop to sign in. You can also connect later from your profile.
            </Text>
          </View>
        )}
      </ScrollView>
    );
  }

  function renderStep() {
    switch (step) {
      case 0:  return renderWelcome();
      case 1:  return renderBirthday();
      case 2:  return renderRaces();
      case 3:  return renderWhoop();
      default: return null;
    }
  }

  // ── Footer state ───────────────────────────────────────────────────────────

  const canContinue =
    step === 0 ? true :
    step === 1 ? dobTouched :
    step === 2 ? true :
                 hasWhoop !== null;

  const buttonLabel =
    saving      ? 'Setting up…' :
    step === 0  ? 'Get Started' :
    step === 3  ? 'Finish' :
                  'Continue';

  function handleNext() {
    if (step === TOTAL_STEPS - 1) { void handleFinish(); return; }
    setStep(s => s + 1);
  }

  const pickerVisible = datePickerIdx !== null;

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <Logo width={150} />

      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => setStep(s => Math.max(0, s - 1))}
          disabled={step === 0 || saving}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          {step > 0 && <Feather name="arrow-left" color={Colors.textPrimary} size={22} />}
        </TouchableOpacity>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
        </View>
        <View style={styles.backBtn} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={{ flex: 1 }}>{renderStep()}</View>

        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.continueBtn, (!canContinue || saving) && styles.continueBtnDisabled]}
            onPress={handleNext}
            disabled={!canContinue || saving}
          >
            <Text style={styles.continueBtnText}>{buttonLabel}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      {/* Race date picker — modal spinner on iOS, native dialog on Android. */}
      {pickerVisible && Platform.OS === 'ios' && (
        <Modal transparent animationType="fade" visible onRequestClose={() => setDatePickerIdx(null)}>
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Race date</Text>
              <DateTimePicker
                value={tempDate}
                mode="date"
                display="spinner"
                themeVariant="dark"
                minimumDate={new Date()}
                onChange={(_e, d) => { if (d) setTempDate(d); }}
                style={{ width: '100%' }}
              />
              <TouchableOpacity style={styles.continueBtn} onPress={() => commitDate(tempDate)}>
                <Text style={styles.continueBtnText}>Set Date</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setDatePickerIdx(null)} style={{ marginTop: 12, alignItems: 'center' }}>
                <Text style={{ color: Colors.textSecondary, fontSize: 13 }}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      )}

      {pickerVisible && Platform.OS !== 'ios' && (
        <DateTimePicker
          value={tempDate}
          mode="date"
          display="default"
          minimumDate={new Date()}
          onChange={(_e, d) => { if (d) commitDate(d); else setDatePickerIdx(null); }}
        />
      )}
    </SafeAreaView>
  );
}

// ─── Styles (mirrors onboarding/index.tsx) ────────────────────────────────────

const styles = StyleSheet.create({
  container:    { flex:1, backgroundColor: Colors.background },

  header:       { flexDirection:'row', alignItems:'center', paddingHorizontal:16, paddingVertical:14, gap:12 },
  backBtn:      { width:40, alignItems:'center', justifyContent:'center' },
  progressTrack:{ flex:1, height:4, backgroundColor: Colors.nested, borderRadius:2, overflow:'hidden' },
  progressFill: { height:'100%', backgroundColor: Colors.accent, borderRadius:2 },

  stepContent:  { gap:12, paddingHorizontal:24, paddingTop:12 },

  label:        { color: Colors.textPrimary, fontSize: 26, fontWeight:'700', lineHeight:34, marginBottom:4 },
  sublabel:     { color: Colors.textSecondary, fontSize:14, lineHeight:20 },
  sectionHeader:{ color: Colors.textSecondary, fontSize:11, fontWeight:'600', letterSpacing:2, marginBottom:4 },

  textInput:    { backgroundColor: Colors.card, borderWidth:1, borderColor: Colors.border, borderRadius:10, paddingHorizontal:16, paddingVertical:14, color: Colors.textPrimary, fontSize:16 },

  option:           { backgroundColor: Colors.card, borderWidth:1, borderColor: Colors.border, borderRadius:10, paddingHorizontal:16, paddingVertical:15 },
  optionTextSelected:{ color: Colors.accent, fontSize:16, fontWeight:'600' },
  optionPlaceholder: { color: Colors.textSecondary, fontSize:16 },

  raceCard:       { backgroundColor: Colors.surface, borderWidth:1, borderColor: Colors.border, borderRadius:14, padding:16, gap:10 },
  raceCardHeader: { flexDirection:'row', alignItems:'center', justifyContent:'space-between' },

  addRaceBtn:  { flexDirection:'row', alignItems:'center', justifyContent:'center', gap:8, paddingVertical:14, borderRadius:10, borderWidth:1, borderColor:'rgba(232,255,71,0.3)', borderStyle:'dashed' },
  addRaceText: { color: Colors.accent, fontSize:15, fontWeight:'600' },

  helperNote:  { color: Colors.textSecondary, fontSize:13, lineHeight:19 },

  twoCardRow:   { flexDirection:'row', gap:10 },
  halfCard:     { flex:1, backgroundColor: Colors.card, borderWidth:1.5, borderColor: Colors.border, borderRadius:14, height:56, alignItems:'center', justifyContent:'center' },
  halfCardSelected: { backgroundColor: Colors.nested, borderWidth:1.5, borderColor: Colors.accent },
  halfCardTitle:{ color: Colors.textPrimary, fontSize:16, fontWeight:'700' },

  infoCard: { backgroundColor: Colors.card, borderRadius:12, padding:16, borderLeftWidth:3, borderLeftColor: Colors.accent },
  infoText: { color: Colors.textPrimary, fontSize:14, lineHeight:20 },

  secondaryBtn:     { borderWidth:1.5, borderColor: Colors.accent, borderRadius:10, paddingVertical:15, alignItems:'center' },
  secondaryBtnText: { color: Colors.accent, fontSize:16, fontWeight:'700' },

  footer:          { paddingHorizontal:24, paddingTop:8, paddingBottom:16, gap:8 },
  continueBtn:     { backgroundColor: Colors.accent, borderRadius:10, paddingVertical:16, alignItems:'center' },
  continueBtnDisabled: { opacity:0.4 },
  continueBtnText: { color: Colors.background, fontSize:16, fontWeight:'700' },

  modalBackdrop: { flex:1, backgroundColor:'rgba(0,0,0,0.7)', justifyContent:'center', paddingHorizontal:24 },
  modalCard:     { backgroundColor: Colors.card, borderRadius:16, padding:20, borderWidth:1, borderColor: Colors.border },
  modalTitle:    { color: Colors.textPrimary, fontSize:18, fontWeight:'700', textAlign:'center', marginBottom:8 },
});
