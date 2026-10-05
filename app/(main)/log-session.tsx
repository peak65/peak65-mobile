import React, { useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../../lib/supabase';
import HRUploadPrompt from '../../components/HRUploadPrompt';
import { canShowUndo, confirmUndo, dropLogFromCaches, reportUndoResult, undoSessionLog } from '../../lib/sessionLogUndo';
import { Colors, Fonts } from '../../lib/theme';
import { getSessionPaceTargets } from '../../lib/pace';
import { isRestRow } from '../../lib/exerciseNotes';
import type { MainStackParamList, ProgramSession } from '../_layout';

type LogSessionRouteProp = RouteProp<MainStackParamList, 'LogSession'>;

// The athlete's answer for ONE paced piece. Kept per-piece rather than as three
// screen-level scalars, which is what silently discarded every answer after the
// first on a session with more than one prescription.
type PaceAnswer = { hit: boolean | null; actual: string; note: string };

// What an untouched piece reads as. Shared constant so a key that has never been
// tapped renders as unanswered instead of crashing on an undefined lookup.
const EMPTY_PACE_ANSWER: PaceAnswer = { hit: null, actual: '', note: '' };

function detectSessionType(session: ProgramSession): 'time_trial' | 'amrap' | 'strength' | 'z2' | 'cardio' {
  const name = (session.name ?? '').toLowerCase();
  const desc = (session.description ?? '').toLowerCase();
  // A rest row is never evidence of what kind of session this is.
  const exercises = (session.blocks ?? []).flatMap(b => b.exercises ?? []).filter(e => !isRestRow(e));
  const types = exercises.map(e => (e as any).type as string ?? '');

  // Zone 2 when at least one exercise is z2_cardio and every TYPED exercise is.
  // Untyped exercises are ignored rather than counted against it; the "at least
  // one" condition keeps a session with no types at all from reading as z2.
  const typed = types.filter(t => t !== '');
  const isZ2ByType = typed.includes('z2_cardio') && typed.every(t => t === 'z2_cardio');

  if (/time trial|time-trial/.test(name) || exercises.some(e => /time.trial/i.test(e.name))) return 'time_trial';
  if (/amrap/.test(name) || /amrap/.test(desc)) return 'amrap';
  if (isZ2ByType || /zone 2|z2/.test(name)) return 'z2';
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
  // Gate HR upload OFF for strength sessions (HR is meaningless for lifts).
  // Trust the authoritative program value first; fall back to the heuristic,
  // which only ever over-detects strength (never flags real cardio as strength).
  const isStrengthSession =
    (session.session_type?.toLowerCase().includes('strength') ?? false) ||
    sessionType === 'strength';

  // Every prescribed pace this session carries, in prescription order. Keyed on
  // sessionJson rather than `session` because `session` is re-parsed on every
  // render, so the object identity is never stable.
  const paceTargets = useMemo(() => getSessionPaceTargets(session), [sessionJson]);
  // The single gate every pace-aware branch below reads. !isStrengthSession is
  // deliberate: a lift carrying a stray pace or pace_zone must never surface the
  // question, since there is no split to hit.
  const showPaceBlock = paceTargets.length > 0 && !isStrengthSession;

  const [trialValue, setTrialValue] = useState('');
  const [rounds, setRounds] = useState(0);
  const [rpe, setRpe] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [wasModified, setWasModified] = useState(false);
  const [modificationText, setModificationText] = useState('');
  // Pace execution, one entry per paced piece keyed by PaceTargetItem.key. Only
  // ever asked when showPaceBlock — a piece stays unanswered (hit: null) until
  // the athlete taps, which is what the save guard requires.
  const [paceAnswers, setPaceAnswers] = useState<Record<string, PaceAnswer>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sessionLogId, setSessionLogId] = useState<string | null>(null);
  // When the save landed, by this phone's clock. The row was created moments
  // ago, so this only gates showing Undo; the server judges the real window
  // from logged_at.
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  React.useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  // Reading a key that was never written must not crash — an untapped piece is
  // simply unanswered.
  const answerFor = (key: string): PaceAnswer => paceAnswers[key] ?? EMPTY_PACE_ANSWER;

  // Immutable single-key patch. Functional form so two taps in the same frame
  // can't clobber each other.
  function setPaceAnswer(key: string, patch: Partial<PaceAnswer>) {
    setPaceAnswers(prev => ({
      ...prev,
      [key]: { ...(prev[key] ?? EMPTY_PACE_ANSWER), ...patch },
    }));
  }

  // One result row per paced piece, in prescription order — the value written to
  // session_logs.pace_results and the source of every rollup scalar below. Empty
  // whenever the question was never asked, which nulls all four pace columns.
  const paceResults = showPaceBlock
    ? paceTargets.map(item => {
        const answer = answerFor(item.key);
        return {
          key:          item.key,
          name:         item.name,
          prescribed:   item.value,
          is_zone_only: item.isZoneOnly,
          hit:          answer.hit,
          actual:       answer.hit === false ? (answer.actual.trim() || null) : null,
          note:         answer.hit === false ? (answer.note.trim()   || null) : null,
        };
      })
    : [];

  // Any piece still unanswered, or missed without the follow-up detail. Drives
  // both the save guards and the SAVE button's disabled state, so the two can't
  // disagree.
  const pacePending = paceResults.some(
    r => r.hit === null || (r.hit === false && (!r.actual || !r.note)),
  );

  async function saveSession() {
    if (!userId) return;
    if (wasModified && !modificationText.trim()) {
      Alert.alert('One more thing', 'Tell your coach what you changed and why.');
      return;
    }
    // Multi-piece sessions name the piece that's missing an answer — "hit your
    // target" is useless guidance when the screen is asking about three ergs.
    const multi = paceResults.length > 1;
    const unanswered = paceResults.find(r => r.hit === null);
    if (unanswered) {
      Alert.alert(
        'One more thing',
        multi
          ? `Let your coach know if you hit your target on ${unanswered.name}.`
          : 'Let your coach know if you hit your target.',
      );
      return;
    }
    const missingDetail = paceResults.find(r => r.hit === false && (!r.actual || !r.note));
    if (missingDetail) {
      Alert.alert(
        'One more thing',
        multi
          ? `Tell your coach what you actually hit on ${missingDetail.name} and why.`
          : 'Tell your coach what you actually hit and why.',
      );
      return;
    }
    setSaving(true);
    try {
      // Rollup scalars. The coach portal's "Missed" chip, the expanded session
      // detail and weekly generation all still read these, so they keep their
      // exact single-piece meaning and only gain a joined form when a session
      // genuinely has several prescriptions.
      const missedResults = paceResults.filter(r => r.hit === false);
      const hitTargetRollup =
        paceResults.length === 0      ? null
        : missedResults.length > 0    ? false
        : paceResults.every(r => r.hit === true) ? true
        : null;
      const prescribedRollup =
        paceResults.length === 0 ? null
        : paceResults.length === 1 ? paceResults[0].prescribed
        : paceResults.map(r => `${r.name} ${r.prescribed}`).join(' · ');
      const actualRollup =
        missedResults.length === 0 ? null
        : paceResults.length === 1 ? paceResults[0].actual
        : missedResults.map(r => `${r.name} ${r.actual}`).join(' · ');
      const missNoteRollup =
        missedResults.length === 0 ? null
        : paceResults.length === 1 ? paceResults[0].note
        : missedResults.map(r => `${r.name}: ${r.note}`).join(' · ');

      const payload = {
        user_id:              userId,
        program_id:           programId,
        day:                  dayName,
        day_name:             dayName,
        session_type:         session.session_type ?? null,
        session_name:         session.name,
        session_time:         session.time ?? null,
        session_type_context: sessionType,
        log_field:            sessionType === 'time_trial' ? 'time' : sessionType === 'amrap' ? 'rounds' : 'completed',
        log_value:            sessionType === 'time_trial' ? trialValue : sessionType === 'amrap' ? String(rounds) : 'true',
        rpe_logged:           rpe ? String(rpe) : null,
        notes:                notes || null,
        was_modified:         wasModified,
        modification_note:    wasModified ? (modificationText.trim() || null) : null,
        pace_results:         paceResults.length > 0 ? paceResults : null,
        hit_target:           hitTargetRollup,
        actual_pace:          actualRollup,
        miss_note:            missNoteRollup,
        prescribed_pace:      prescribedRollup,
        week_number:          weekNumber,
        completed:            true,
        completed_at:         new Date().toISOString(),
        session_date:         new Date().toISOString().split('T')[0],
      };
      // Never the payload itself: it carries the athlete's notes and results.
      console.log('[log-session] inserting session log — type:', sessionType, '| pace pieces:', paceResults.length);

      const { data, error } = await supabase
        .from('session_logs')
        .insert(payload)
        .select('id')
        .single();

      if (error) throw error;
      setSessionLogId(data?.id ?? null);
      setSavedAt(Date.now());
      setSaved(true);
    } catch (err) {
      // FIX 1: log full error object
      console.error('[log-session] save error (full):', err);
      Alert.alert('Error', 'Could not save session. Try again.');
    }
    setSaving(false);
  }

  // ── Undo ────────────────────────────────────────────────────────────────────

  function handleUndo() {
    if (!sessionLogId || undoing) return;
    const id = sessionLogId;
    confirmUndo(async () => {
      setUndoing(true);
      const result = await undoSessionLog(id);
      setUndoing(false);
      // Back to the screen this was logged from. Its focus reload re-reads
      // session_logs, so the session shows as not completed again.
      const gone = reportUndoResult(result, () => navigation.goBack());
      if (gone) void dropLogFromCaches(id);
    });
  }

  const undoControl = sessionLogId && canShowUndo(savedAt) ? (
    <TouchableOpacity style={ls.undoBtn} onPress={handleUndo} disabled={undoing}>
      <Text style={ls.undoBtnTxt}>{undoing ? 'Deleting...' : 'Logged by mistake? Undo'}</Text>
    </TouchableOpacity>
  ) : null;

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

          {/* Prescribed vs modified */}
          {!saved && (
            <View style={ls.section}>
              <Text style={ls.label}>DID THIS GO AS PRESCRIBED?</Text>
              <View style={ls.modRow}>
                <TouchableOpacity
                  style={[ls.modOption, !wasModified && ls.modOptionSelected]}
                  onPress={() => setWasModified(false)}
                >
                  <Text style={[ls.modOptionTxt, !wasModified && ls.modOptionTxtSelected]}>Did it as prescribed</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[ls.modOption, wasModified && ls.modOptionSelected]}
                  onPress={() => setWasModified(true)}
                >
                  <Text style={[ls.modOptionTxt, wasModified && ls.modOptionTxtSelected]}>Had to modify</Text>
                </TouchableOpacity>
              </View>
              {wasModified && (
                <View style={ls.modTextWrap}>
                  <Text style={ls.label}>WHAT DID YOU CHANGE, AND WHY?</Text>
                  <TextInput
                    style={[ls.input, ls.notesInput]}
                    value={modificationText}
                    onChangeText={setModificationText}
                    placeholder="e.g. Pulled the last round — was in Zone 5 and it would've been junk volume. Tell your coach what happened."
                    placeholderTextColor={Colors.textSecondary}
                    multiline
                    numberOfLines={3}
                    textAlignVertical="top"
                  />
                </View>
              )}
            </View>
          )}

          {/* Pace execution — one question per paced piece, so a threshold
              session with a Ski Erg and a Row Erg at different splits captures
              both answers instead of only the first. Never shown on a strength
              session. A zone-only target ("zone4") is an effort band, not a
              split, so it asks about holding the zone instead. With a single
              piece this renders exactly as it always has — no name label. */}
          {showPaceBlock && !saved && (
            <View style={ls.section}>
              <Text style={ls.label}>
                {paceTargets.length > 1
                  ? 'DID YOU HIT YOUR TARGET PACES?'
                  : paceTargets[0].isZoneOnly
                    ? 'DID YOU HOLD YOUR TARGET ZONE?'
                    : 'DID YOU HIT YOUR TARGET PACE?'}
              </Text>
              {paceTargets.map((item, idx) => {
                const answer = answerFor(item.key);
                return (
                  <View key={item.key} style={idx > 0 ? ls.paceGroup : undefined}>
                    {paceTargets.length > 1 && (
                      <Text style={ls.paceGroupName}>{item.name}</Text>
                    )}
                    <Text style={ls.paceTargetTxt}>
                      {item.isZoneOnly ? item.value : `Target: ${item.value}`}
                    </Text>
                    <View style={ls.modRow}>
                      <TouchableOpacity
                        style={[ls.modOption, answer.hit === true && ls.modOptionSelected]}
                        onPress={() => setPaceAnswer(item.key, { hit: true })}
                      >
                        <Text style={[ls.modOptionTxt, answer.hit === true && ls.modOptionTxtSelected]}>Hit it</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[ls.modOption, answer.hit === false && ls.modOptionSelected]}
                        onPress={() => setPaceAnswer(item.key, { hit: false })}
                      >
                        <Text style={[ls.modOptionTxt, answer.hit === false && ls.modOptionTxtSelected]}>Missed it</Text>
                      </TouchableOpacity>
                    </View>
                    {answer.hit === false && (
                      <View style={ls.modTextWrap}>
                        <Text style={ls.label}>WHAT DID YOU ACTUALLY HIT?</Text>
                        <TextInput
                          style={ls.input}
                          value={answer.actual}
                          onChangeText={text => setPaceAnswer(item.key, { actual: text })}
                          placeholder={item.isZoneOnly ? 'e.g. mostly Zone 3' : 'e.g. 6:45/mi — your actual average'}
                          placeholderTextColor={Colors.textSecondary}
                          keyboardType={item.isZoneOnly ? 'default' : 'numbers-and-punctuation'}
                          autoCorrect={false}
                        />
                        <Text style={[ls.label, ls.missNoteLabel]}>WHAT GOT IN THE WAY?</Text>
                        <TextInput
                          style={[ls.input, ls.notesInput]}
                          value={answer.note}
                          onChangeText={text => setPaceAnswer(item.key, { note: text })}
                          placeholder="Tell your coach what happened — legs, weather, effort, etc."
                          placeholderTextColor={Colors.textSecondary}
                          multiline
                          numberOfLines={3}
                          textAlignVertical="top"
                        />
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          )}

          {/* Save button — FIX 4: explicit #e8ff47 / #080808 */}
          {!saved && (
            <TouchableOpacity
              style={[ls.saveBtn, (saving || (sessionType === 'time_trial' && !trialValue.trim()) || (wasModified && !modificationText.trim()) || pacePending) && ls.saveBtnDisabled]}
              onPress={saveSession}
              disabled={saving || (sessionType === 'time_trial' && !trialValue.trim()) || (wasModified && !modificationText.trim()) || pacePending}
            >
              <Text style={ls.saveBtnTxt}>{saving ? 'SAVING...' : 'SAVE SESSION →'}</Text>
            </TouchableOpacity>
          )}

          {/* Saved state — strength skips HR upload (HR is meaningless for lifts) */}
          {saved && isStrengthSession && (
            <View style={ls.savedContainer}>
              <View style={ls.strengthDoneCard}>
                <Text style={ls.strengthDoneTxt}>SESSION LOGGED ✓</Text>
              </View>
              <TouchableOpacity style={ls.saveBtn} onPress={() => navigation.goBack()}>
                <Text style={ls.saveBtnTxt}>DONE</Text>
              </TouchableOpacity>
              {undoControl}
            </View>
          )}

          {/* Saved state + HR upload (cardio) */}
          {saved && !isStrengthSession && (
            <View style={ls.savedContainer}>
              <HRUploadPrompt
                sessionLogId={sessionLogId}
                userId={userId}
                session_type={sessionType}
                prescribed_zone={sessionType === 'time_trial' ? 'zone4' : sessionType === 'z2' ? 'zone2' : 'zone4'}
                onDebrief={() => navigation.goBack()}
                onInvalid={() => {}}
                onNetworkError={() => {}}
                onSkip={() => navigation.goBack()}
              />
              {undoControl}
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
  modRow:          { flexDirection: 'row', gap: 12 },
  modOption:       { flex: 1, paddingVertical: 16, paddingHorizontal: 12, backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center' },
  modOptionSelected: { backgroundColor: '#e8ff47', borderColor: '#e8ff47' },
  modOptionTxt:    { color: '#f0ede8', fontSize: 14, fontWeight: '600', textAlign: 'center' },
  modOptionTxtSelected: { color: '#080808' },
  modTextWrap:     { marginTop: 20 },
  paceTargetTxt:   { color: Colors.textPrimary, fontSize: 18, fontFamily: Fonts.metric, marginBottom: 14 },
  // Separates the 2nd..nth paced piece so they read as distinct questions.
  // Never applied to the first, which keeps the single-piece layout untouched.
  paceGroup:       { marginTop: 24, paddingTop: 24, borderTopWidth: 1, borderTopColor: '#1a1a1a' },
  // Sub-label under the accent section header: same metrics as ls.label, in the
  // secondary tone so the piece name reads below the question, not beside it.
  paceGroupName:   { color: Colors.textSecondary, fontSize: 11, fontWeight: '700', letterSpacing: 2, textTransform: 'uppercase', marginBottom: 8 },
  missNoteLabel:   { marginTop: 20 },
  // FIX 4: explicit #e8ff47 / #080808
  saveBtn:         { marginHorizontal: 20, backgroundColor: '#e8ff47', paddingVertical: 20, alignItems: 'center' },
  saveBtnDisabled: { opacity: 0.4 },
  saveBtnTxt:      { color: '#080808', fontSize: 16, fontWeight: '700', letterSpacing: 1 },
  savedContainer:  { paddingTop: 16 },
  undoBtn:         { alignItems: 'center', paddingVertical: 14, marginHorizontal: 20, marginTop: 8 },
  undoBtnTxt:      { color: Colors.textSecondary, fontSize: 14, textDecorationLine: 'underline' },
  hrHeading:       { color: '#e8ff47', fontSize: 13, fontWeight: '700', letterSpacing: 2, textTransform: 'uppercase', textAlign: 'center', marginBottom: 0 },
  strengthDoneCard:{ marginHorizontal: 20, marginBottom: 16, paddingVertical: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.card },
  strengthDoneTxt: { color: '#e8ff47', fontSize: 20, fontWeight: '700', letterSpacing: 2, fontFamily: Fonts.metric },
});
