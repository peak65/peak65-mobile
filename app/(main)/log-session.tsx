import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../../lib/supabase';
import HRUploadPrompt from '../../components/HRUploadPrompt';
import { Colors, Fonts } from '../../lib/theme';
import type { MainStackParamList, ProgramSession } from '../_layout';

type LogSessionRouteProp = RouteProp<MainStackParamList, 'LogSession'>;

function detectSessionType(session: ProgramSession): 'time_trial' | 'amrap' | 'strength' | 'z2' | 'cardio' {
  const name = (session.name ?? '').toLowerCase();
  const desc = (session.description ?? '').toLowerCase();
  const exercises = (session.blocks ?? []).flatMap(b => b.exercises ?? []);
  const types = exercises.map(e => (e as any).type as string ?? '');

  if (/time trial|time-trial/.test(name) || exercises.some(e => /time.trial/i.test(e.name))) return 'time_trial';
  if (/amrap/.test(name) || /amrap/.test(desc)) return 'amrap';
  if (types.every(t => t === 'z2_cardio') || /zone 2|z2/.test(name)) return 'z2';
  if (types.some(t => t === 'strength')) return 'strength';
  return 'cardio';
}

function getTrialLabel(session: ProgramSession): string {
  const name = session.name ?? '';
  if (/8k/i.test(name)) return '8K TIME';
  if (/5k/i.test(name)) return '5K TIME';
  if (/3k/i.test(name)) return '3K TIME';
  if (/ski/i.test(name)) return 'SKI ERG SPLIT (MM:SS per 500m)';
  if (/row/i.test(name)) return 'ROW ERG SPLIT (MM:SS per 500m)';
  return 'RESULT (MM:SS)';
}

export default function LogSessionScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const route = useRoute<LogSessionRouteProp>();
  const { sessionJson, programId, weekNumber, dayName } = route.params;
  const session: ProgramSession = JSON.parse(sessionJson);
  const sessionType = detectSessionType(session);

  const [trialValue, setTrialValue] = useState('');
  const [rounds, setRounds] = useState(0);
  const [rpe, setRpe] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sessionLogId, setSessionLogId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  React.useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  async function saveSession() {
    if (!userId) return;
    setSaving(true);
    try {
      const payload = {
        user_id:              userId,
        program_id:           programId,
        day_name:             dayName,
        session_name:         session.name,
        session_type_context: sessionType,
        log_field:            sessionType === 'time_trial' ? 'time' : sessionType === 'amrap' ? 'rounds' : 'completed',
        log_value:            sessionType === 'time_trial' ? trialValue : sessionType === 'amrap' ? String(rounds) : 'true',
        rpe_logged:           rpe ? String(rpe) : null,
        notes:                notes || null,
        week_number:          weekNumber,
        completed:            true,
        completed_at:         new Date().toISOString(),
        session_date:         new Date().toISOString().split('T')[0],
      };
      console.log('[log-session] inserting payload:', JSON.stringify(payload, null, 2));

      const { data, error } = await supabase
        .from('session_logs')
        .insert(payload)
        .select('id')
        .single();

      if (error) throw error;
      setSessionLogId(data?.id ?? null);
      setSaved(true);
    } catch (err) {
      // FIX 1: log full error object
      console.error('[log-session] save error (full):', err);
      Alert.alert('Error', 'Could not save session. Try again.');
    }
    setSaving(false);
  }

  return (
    <SafeAreaView style={ls.container} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={ls.scroll} keyboardShouldPersistTaps="handled">

          {/* Header — FIX 4: accent border line below */}
          <View style={ls.headerWrap}>
            <View style={ls.header}>
              <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <Text style={ls.back}>← Back</Text>
              </TouchableOpacity>
              <Text style={ls.title}>LOG SESSION</Text>
              <View style={{ width: 60 }} />
            </View>
            <View style={ls.headerBorder} />
          </View>

          {/* FIX 4: session name in accent yellow, Barlow Condensed, 28px */}
          <Text style={ls.sessionName}>{session.name}</Text>
          <Text style={ls.sessionMeta}>{dayName} · Week {weekNumber}</Text>

          <View style={ls.divider} />

          {/* Time trial input */}
          {sessionType === 'time_trial' && !saved && (
            <View style={ls.section}>
              <Text style={ls.label}>{getTrialLabel(session)}</Text>
              <TextInput
                style={ls.input}
                value={trialValue}
                onChangeText={setTrialValue}
                placeholder="e.g. 38:24"
                placeholderTextColor={Colors.textSecondary}
                keyboardType="numbers-and-punctuation"
                autoCorrect={false}
              />
            </View>
          )}

          {/* AMRAP rounds input */}
          {sessionType === 'amrap' && !saved && (
            <View style={ls.section}>
              <Text style={ls.label}>ROUNDS COMPLETED</Text>
              <View style={ls.roundsRow}>
                <TouchableOpacity
                  style={ls.roundBtn}
                  onPress={() => setRounds(r => Math.max(0, r - 1))}
                >
                  <Text style={ls.roundBtnTxt}>−</Text>
                </TouchableOpacity>
                <Text style={ls.roundsNum}>{rounds}</Text>
                <TouchableOpacity
                  style={ls.roundBtn}
                  onPress={() => setRounds(r => r + 1)}
                >
                  <Text style={ls.roundBtnTxt}>+</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* RPE — FIX 4: all selected = #e8ff47 bg, unselected = #1a1a1a bg */}
          {!saved && (
            <View style={ls.section}>
              <Text style={ls.label}>RPE — HOW HARD WAS IT?</Text>
              <View style={ls.rpeRow}>
                {[1,2,3,4,5,6,7,8,9,10].map(n => (
                  <TouchableOpacity
                    key={n}
                    style={[ls.rpeDot, rpe === n && ls.rpeDotSelected]}
                    onPress={() => setRpe(n)}
                  >
                    <Text style={[ls.rpeTxt, rpe === n && ls.rpeTxtSelected]}>{n}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              {rpe && (
                <Text style={ls.rpeLabel}>
                  {rpe <= 4 ? 'Easy' : rpe <= 6 ? 'Moderate' : rpe <= 7 ? 'Hard' : rpe <= 8 ? 'Very hard' : 'Maximum'}
                </Text>
              )}
            </View>
          )}

          {/* Notes */}
          {!saved && (
            <View style={ls.section}>
              <Text style={ls.label}>NOTES (OPTIONAL)</Text>
              <TextInput
                style={[ls.input, ls.notesInput]}
                value={notes}
                onChangeText={setNotes}
                placeholder="How did it feel? Anything your coach should know?"
                placeholderTextColor={Colors.textSecondary}
                multiline
                numberOfLines={3}
                textAlignVertical="top"
              />
            </View>
          )}

          {/* Save button — FIX 4: explicit #e8ff47 / #080808 */}
          {!saved && (
            <TouchableOpacity
              style={[ls.saveBtn, (saving || (sessionType === 'time_trial' && !trialValue.trim())) && ls.saveBtnDisabled]}
              onPress={saveSession}
              disabled={saving || (sessionType === 'time_trial' && !trialValue.trim())}
            >
              <Text style={ls.saveBtnTxt}>{saving ? 'SAVING...' : 'SAVE SESSION →'}</Text>
            </TouchableOpacity>
          )}

          {/* Saved state + HR upload */}
          {saved && (
            <View style={ls.savedContainer}>
              <HRUploadPrompt
                sessionLogId={sessionLogId}
                userId={userId}
                onDebrief={() => navigation.goBack()}
                onInvalid={() => {}}
                onNetworkError={() => {}}
                onSkip={() => navigation.goBack()}
              />
            </View>
          )}

        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const ls = StyleSheet.create({
  container:       { flex: 1, backgroundColor: Colors.background },
  scroll:          { paddingBottom: 48 },
  headerWrap:      {},
  header:          { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12 },
  headerBorder:    { height: 1, backgroundColor: '#e8ff47', marginHorizontal: 20 },
  back:            { color: Colors.textSecondary, fontSize: 15 },
  title:           { color: Colors.textPrimary, fontSize: 13, fontWeight: '700', letterSpacing: 2 },
  // FIX 4: accent yellow, Barlow Condensed, 28px
  sessionName:     { color: '#e8ff47', fontSize: 28, fontFamily: Fonts.metric, paddingHorizontal: 20, marginTop: 16 },
  sessionMeta:     { color: Colors.textSecondary, fontSize: 14, paddingHorizontal: 20, marginTop: 4 },
  divider:         { height: 1, backgroundColor: 'rgba(255,255,255,0.06)', marginVertical: 20, marginHorizontal: 20 },
  section:         { paddingHorizontal: 20, marginBottom: 28 },
  // FIX 4: section labels in accent yellow
  label:           { color: '#e8ff47', fontSize: 11, fontWeight: '700', letterSpacing: 2, textTransform: 'uppercase', marginBottom: 12 },
  input:           { backgroundColor: Colors.card, color: Colors.textPrimary, fontSize: 18, paddingHorizontal: 16, paddingVertical: 14, borderRadius: 0 },
  notesInput:      { height: 88, fontSize: 15 },
  roundsRow:       { flexDirection: 'row', alignItems: 'center', gap: 24 },
  roundBtn:        { width: 52, height: 52, backgroundColor: Colors.card, alignItems: 'center', justifyContent: 'center' },
  roundBtnTxt:     { color: Colors.textPrimary, fontSize: 28, fontWeight: '300' },
  roundsNum:       { color: Colors.accent, fontSize: 64, fontFamily: Fonts.metricHeavy, minWidth: 80, textAlign: 'center' },
  rpeRow:          { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  // FIX 4: unselected = #1a1a1a bg
  rpeDot:          { width: 44, height: 44, borderRadius: 22, backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center' },
  // FIX 4: selected = #e8ff47 bg (uniform, not per-RPE color)
  rpeDotSelected:  { backgroundColor: '#e8ff47', borderColor: '#e8ff47' },
  rpeTxt:          { color: '#f0ede8', fontSize: 14, fontWeight: '600' },
  rpeTxtSelected:  { color: '#080808' },
  rpeLabel:        { color: Colors.textSecondary, fontSize: 13, marginTop: 10 },
  // FIX 4: explicit #e8ff47 / #080808
  saveBtn:         { marginHorizontal: 20, backgroundColor: '#e8ff47', paddingVertical: 20, alignItems: 'center' },
  saveBtnDisabled: { opacity: 0.4 },
  saveBtnTxt:      { color: '#080808', fontSize: 16, fontWeight: '700', letterSpacing: 1 },
  savedContainer:  { paddingTop: 16 },
  hrHeading:       { color: '#e8ff47', fontSize: 13, fontWeight: '700', letterSpacing: 2, textTransform: 'uppercase', textAlign: 'center', marginBottom: 0 },
});
