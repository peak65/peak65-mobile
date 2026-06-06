import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  StyleSheet, ActivityIndicator, Modal, Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { Feather } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { Colors, Fonts } from '../../lib/theme';
import Tooltip from '../components/Tooltip';
import type { TabParamList } from '../_layout';

const ORANGE    = '#ff9944';
const BAR_MAX_H = 80;

// ─── Types ────────────────────────────────────────────────────────────────────

type Checkin = {
  id: string;
  created_at: string;
  weight: number | null;
  weight_unit: string | null;
  body_fat_percentage: number | null;
};

type SessionLog = {
  id: string;
  completed_at: string;
  day_index: number | null;
  rpe: number | null;
  rpe_logged: number | null;
  duration: number | null;
  week_number: number | null;
  log_value: string | null;
  notes: string | null;
  session_type: string | null;
  session_name: string | null;
  title: string | null;
  day_type: string | null;
  day_name: string | null;
  program_id: string | null;
  hr_zones: string | null;
};

type ExternalWorkout = {
  id: string;
  workout_type: string;
  start_time: string;
  end_time: string;
  duration_minutes: number;
  calories: number | null;
  source: string;
  acknowledged: boolean;
  distance_km: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  pace_per_km: number | null;
  effort_zone: string | null;
  hr_zones: string | null;
  activity_type: string | null;
};

type HistoryItem =
  | { kind: 'session'; data: SessionLog }
  | { kind: 'workout'; data: ExternalWorkout };

const WORKOUT_TYPE_LABELS: Record<string, string> = {
  run:      'Running',
  bike:     'Cycling',
  strength: 'Strength Training',
  hiit:     'HIIT',
  swim:     'Swimming',
  row:      'Rowing',
  hike:     'Hiking',
  walk:     'Walking',
  yoga:     'Yoga',
  cross:    'Cross Training',
  other:    'Workout',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateShort(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function fmtDuration(s: number | null): string {
  if (!s) return '';
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function rpeColor(rpe: number | null): string {
  if (!rpe) return Colors.textSecondary;
  if (rpe <= 3) return Colors.green;
  if (rpe <= 6) return Colors.accent;
  if (rpe <= 8) return '#ff9944';
  return Colors.red;
}

function getSessionTitle(log: SessionLog): string {
  const clean = (v: string | null | undefined) =>
    v && v !== 'undefined' && v !== 'null' && v.trim().length > 0 ? v.trim() : null;
  if (clean(log.session_name)) return clean(log.session_name)!;
  if (clean(log.session_type)) return clean(log.session_type)!;
  if (clean(log.title))        return clean(log.title)!;
  if (clean(log.day_type))     return clean(log.day_type)!;
  if (clean(log.day_name))     return clean(log.day_name)!;
  if (log.day_index != null && log.day_index >= 0 && log.day_index <= 6) {
    return ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][log.day_index] + ' Session';
  }
  return 'Training Session';
}

function formatPace(pacePerKm: number, imperial: boolean): string {
  const pace = imperial ? pacePerKm * 1.60934 : pacePerKm;
  const mins = Math.floor(pace / 60);
  const secs = Math.round(pace % 60).toString().padStart(2, '0');
  return `${mins}:${secs}/${imperial ? 'mi' : 'km'}`;
}

function formatDistance(distKm: number, imperial: boolean): string {
  if (imperial) return `${(distKm * 0.621371).toFixed(2)} mi`;
  return `${distKm.toFixed(2)} km`;
}

function longestStreak(logs: SessionLog[]): number {
  const dates = [...new Set(logs.map(l =>
    new Date(l.completed_at).toLocaleDateString('en-CA')))]
    .sort().reverse();
  let max = 0, cur = 0;
  for (let i = 0; i < dates.length; i++) {
    if (i === 0) { cur = 1; max = 1; continue; }
    const prev = new Date(dates[i - 1] + 'T00:00:00');
    const curr = new Date(dates[i] + 'T00:00:00');
    const diff = Math.round((prev.getTime() - curr.getTime()) / 86_400_000);
    if (diff === 1) { cur++; max = Math.max(max, cur); }
    else cur = 1;
  }
  return max;
}

// ─── Bar chart ────────────────────────────────────────────────────────────────

function BarChart({ values, labels, unit }: { values: number[]; labels: string[]; unit: string }) {
  if (!values.length) {
    return (
      <View style={styles.chartEmpty}>
        <Text style={styles.chartEmptyText}>No data yet.</Text>
      </View>
    );
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.barsRow}>
          {values.map((v, i) => {
            const h = ((v - min) / range) * BAR_MAX_H + 10;
            return (
              <View key={i} style={styles.barCol}>
                <Text style={styles.barVal}>{v % 1 === 0 ? v : v.toFixed(1)}</Text>
                <View style={[styles.bar, { height: h }]} />
                <Text style={styles.barLabel}>{labels[i]}</Text>
              </View>
            );
          })}
        </View>
      </ScrollView>
      <Text style={styles.barUnit}>{unit}</Text>
    </View>
  );
}

// ─── Detail modal ─────────────────────────────────────────────────────────────

function SessionDetailModal({
  log: logProp,
  onClose,
}: {
  log: SessionLog;
  onClose: () => void;
}) {
  const [log, setLog] = useState(logProp);
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'loading'>('idle');

  async function handleUploadHR() {
    let ImagePicker: any;
    try {
      ImagePicker = require('expo-image-picker');
    } catch {
      Alert.alert('Not available', 'expo-image-picker is not installed.');
      return;
    }

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission required', 'Please allow access to your photo library.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      base64: true,
      quality: 0.85,
    });

    if (result.canceled || !result.assets?.[0]?.base64) return;

    setUploadStatus('loading');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const userId = session?.user?.id;

      const { data: profileData } = await supabase
        .from('profiles')
        .select('tier')
        .eq('id', userId)
        .maybeSingle();
      const tier = (profileData as any)?.tier ?? 'ai_coached';

      const base64Image = result.assets[0].base64 as string;
      const res = await fetch('https://peak65.vercel.app/api/extract-hr-zones', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64Image, sessionLogId: log.id, tier, userId }),
      });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const responseData = await res.json();
      const zones = responseData.zones ?? responseData;

      await supabase
        .from('session_logs')
        .update({ hr_zones: JSON.stringify(zones) })
        .eq('id', log.id);

      setLog(prev => ({ ...prev, hr_zones: JSON.stringify(zones) }));
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Something went wrong. Please try again.');
    } finally {
      setUploadStatus('idle');
    }
  }

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <View style={styles.detailBackdrop}>
        <View style={styles.detailSheet}>
          <View style={styles.detailHeader}>
            <Text style={styles.detailTitle}>{getSessionTitle(log)}</Text>
            <TouchableOpacity onPress={onClose} style={styles.detailCloseBtn}>
              <Feather name="x" color={Colors.textSecondary} size={20} />
            </TouchableOpacity>
          </View>
          <ScrollView showsVerticalScrollIndicator={false}>
            <Text style={styles.detailDate}>{fmtDate(log.completed_at)}</Text>

            <View style={styles.detailGrid}>
              {log.week_number != null && (
                <View style={styles.detailCell}>
                  <Text style={styles.detailCellLabel}>Week</Text>
                  <Text style={styles.detailCellVal}>{log.week_number}</Text>
                </View>
              )}
              {log.duration != null && (
                <View style={styles.detailCell}>
                  <Text style={styles.detailCellLabel}>Duration</Text>
                  <Text style={styles.detailCellVal}>{fmtDuration(log.duration)}</Text>
                </View>
              )}
              {log.rpe != null && (
                <View style={styles.detailCell}>
                  <Text style={styles.detailCellLabel}>RPE</Text>
                  <Text style={[styles.detailCellVal, { color: rpeColor(log.rpe) }]}>{log.rpe}/10</Text>
                </View>
              )}
              {log.log_value != null && (
                <View style={styles.detailCell}>
                  <Text style={styles.detailCellLabel}>Trial Result</Text>
                  <Text style={styles.detailCellVal}>{log.log_value}</Text>
                </View>
              )}
            </View>

            {log.notes ? (
              <>
                <Text style={styles.detailSectionLabel}>Notes</Text>
                <Text style={styles.detailNotes}>{log.notes}</Text>
              </>
            ) : null}

            {log.hr_zones ? (() => {
              try {
                const zones = JSON.parse(log.hr_zones) as Record<string, number>;
                const keys = ['z1', 'z2', 'z3', 'z4', 'z5'];
                const colors: Record<string, string> = { z1: '#4a9eff', z2: '#4affb8', z3: '#e8ff47', z4: '#ff9944', z5: '#ff4444' };
                return (
                  <>
                    <Text style={[styles.detailSectionLabel, { marginTop: 16 }]}>HR ZONES</Text>
                    <View style={{ gap: 8 }}>
                      {keys.map(z => {
                        const mins = zones[z] ?? 0;
                        if (mins === 0) return null;
                        const total = keys.reduce((s, k) => s + (zones[k] ?? 0), 0);
                        const pct = total > 0 ? Math.round((mins / total) * 100) : 0;
                        return (
                          <View key={z} style={{ gap: 4 }}>
                            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                              <Text style={{ color: colors[z], fontSize: 12, fontWeight: '700' }}>{z.toUpperCase()}</Text>
                              <Text style={{ color: Colors.textSecondary, fontSize: 12 }}>{mins}m · {pct}%</Text>
                            </View>
                            <View style={{ height: 4, backgroundColor: '#222', borderRadius: 2 }}>
                              <View style={{ height: 4, width: `${pct}%` as any, backgroundColor: colors[z], borderRadius: 2 }} />
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  </>
                );
              } catch { return null; }
            })() : null}

            {uploadStatus === 'loading' ? (
              <View style={{ alignItems: 'center', marginTop: 20, gap: 8 }}>
                <ActivityIndicator color={Colors.accent} />
                <Text style={{ color: Colors.textSecondary, fontSize: 13 }}>Reading your HR data...</Text>
              </View>
            ) : (
              <Tooltip id="hr_upload" text="Upload your HR screenshot here after any session. Your coach uses this to track your training zones." arrowDirection="down">
              <TouchableOpacity
                style={styles.saveBtn}
                onPress={handleUploadHR}
              >
                <Text style={styles.saveBtnText}>
                  {log.hr_zones ? 'UPDATE HR DATA' : 'UPLOAD HR DATA'}
                </Text>
              </TouchableOpacity>
              </Tooltip>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const ACTIVITY_TYPES = [
  'Zone 2 Cardio', 'Threshold Run', 'Tempo Run', 'Strength Session',
  'Hyrox Builder', 'Recovery Walk', 'Sport', 'Other',
];

function WorkoutDetailModal({
  workout,
  imperial,
  onClose,
  onAssigned,
}: {
  workout: ExternalWorkout;
  imperial: boolean;
  onClose: () => void;
  onAssigned: () => void;
}) {
  const [localWorkout, setLocalWorkout] = useState(workout);
  const [assignMode, setAssignMode]     = useState(false);
  const [programs, setPrograms]         = useState<{ id: string; week_number: number; program_data: { days: { day: string; sessions: { name: string }[] }[] } }[]>([]);
  const [assigning, setAssigning]       = useState(false);
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'loading'>('idle');
  const [activityType, setActivityType] = useState<string | null>(workout.activity_type ?? null);

  async function handleUploadHR() {
    let ImagePicker: any;
    try {
      ImagePicker = require('expo-image-picker');
    } catch {
      Alert.alert('Not available', 'expo-image-picker is not installed.');
      return;
    }

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission required', 'Please allow access to your photo library.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      base64: true,
      quality: 0.85,
    });

    if (result.canceled || !result.assets?.[0]?.base64) return;

    setUploadStatus('loading');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const userId = session?.user?.id;

      const { data: profileData } = await supabase
        .from('profiles')
        .select('tier')
        .eq('id', userId)
        .maybeSingle();
      const tier = (profileData as any)?.tier ?? 'ai_coached';

      const base64Image = result.assets[0].base64 as string;
      const res = await fetch('https://peak65.vercel.app/api/extract-hr-zones', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64Image, sessionLogId: localWorkout.id, tier, userId }),
      });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const responseData = await res.json();
      const zones = responseData.zones ?? responseData;

      await supabase
        .from('external_workouts')
        .update({ hr_zones: JSON.stringify(zones) })
        .eq('id', localWorkout.id);

      setLocalWorkout(prev => ({ ...prev, hr_zones: JSON.stringify(zones) }));
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Something went wrong. Please try again.');
    } finally {
      setUploadStatus('idle');
    }
  }

  async function handleActivityType(type: string) {
    const newType = activityType === type ? null : type;
    setActivityType(newType);

    await supabase
      .from('external_workouts')
      .update({ activity_type: newType })
      .eq('id', localWorkout.id);

    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user) {
      fetch('https://peak65.vercel.app/api/update-athlete-intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: session.user.id }),
      }).catch(() => {});
    }
  }

  async function loadPrograms() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) return;
    const { data } = await supabase
      .from('programs')
      .select('id, week_number, program_data')
      .eq('user_id', session.user.id)
      .not('is_draft', 'is', true)
      .order('week_number', { ascending: false });
    setPrograms((data ?? []) as any[]);
    setAssignMode(true);
  }

  async function assignTo(programId: string, weekNumber: number, dayName: string, sessionName: string) {
    setAssigning(true);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) { setAssigning(false); return; }
    await supabase.from('session_logs').insert({
      user_id:      session.user.id,
      program_id:   programId,
      week_number:  weekNumber,
      day_name:     dayName,
      session_name: sessionName,
      log_field:    'assigned_workout',
      log_value:    `${localWorkout.duration_minutes} min`,
      completed:    true,
      completed_at: localWorkout.start_time,
    });
    setAssigning(false);
    Alert.alert('Assigned', `Workout assigned to ${sessionName}.`);
    onAssigned();
    onClose();
  }

  if (assignMode) {
    return (
      <Modal transparent animationType="slide" visible onRequestClose={() => setAssignMode(false)}>
        <View style={styles.detailBackdrop}>
          <View style={styles.detailSheet}>
            <View style={styles.detailHeader}>
              <Text style={styles.detailTitle}>Assign to Day</Text>
              <TouchableOpacity onPress={() => setAssignMode(false)} style={styles.detailCloseBtn}>
                <Feather name="x" color={Colors.textSecondary} size={20} />
              </TouchableOpacity>
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>
              {programs.map(prog => (
                prog.program_data?.days?.flatMap(day =>
                  (day.sessions ?? []).map(session => (
                    <TouchableOpacity
                      key={`${prog.id}-${day.day}-${session.name}`}
                      style={[styles.detailCell, { width: '100%', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#222' }]}
                      onPress={() => assignTo(prog.id, prog.week_number, day.day, session.name)}
                      disabled={assigning}
                    >
                      <Text style={[styles.detailCellLabel, { marginBottom: 2 }]}>Week {prog.week_number} · {day.day}</Text>
                      <Text style={[styles.detailCellVal, { fontSize: 14 }]}>{session.name}</Text>
                    </TouchableOpacity>
                  ))
                )
              ))}
              {programs.length === 0 && (
                <Text style={{ color: Colors.textSecondary, textAlign: 'center', marginTop: 24 }}>No programs found.</Text>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    );
  }

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <View style={styles.detailBackdrop}>
        <View style={styles.detailSheet}>
          <View style={styles.detailHeader}>
            <View>
              <Text style={styles.detailOffBadge}>OFF-PROGRAM</Text>
              <Text style={styles.detailTitle}>
                {WORKOUT_TYPE_LABELS[localWorkout.workout_type] ?? localWorkout.workout_type}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.detailCloseBtn}>
              <Feather name="x" color={Colors.textSecondary} size={20} />
            </TouchableOpacity>
          </View>
          <ScrollView showsVerticalScrollIndicator={false}>
            <Text style={styles.detailDate}>
              {fmtDate(localWorkout.start_time)} · {fmtTime(localWorkout.start_time)}
            </Text>

            <View style={styles.detailGrid}>
              <View style={styles.detailCell}>
                <Text style={styles.detailCellLabel}>Duration</Text>
                <Text style={styles.detailCellVal}>{localWorkout.duration_minutes}m</Text>
              </View>
              {localWorkout.distance_km != null && localWorkout.distance_km > 0 && (
                <View style={styles.detailCell}>
                  <Text style={styles.detailCellLabel}>Distance</Text>
                  <Text style={styles.detailCellVal}>{formatDistance(localWorkout.distance_km, imperial)}</Text>
                </View>
              )}
              {localWorkout.calories != null && (
                <View style={styles.detailCell}>
                  <Text style={styles.detailCellLabel}>Calories</Text>
                  <Text style={styles.detailCellVal}>{localWorkout.calories} kcal</Text>
                </View>
              )}
              {localWorkout.avg_hr != null && (
                <View style={styles.detailCell}>
                  <Text style={styles.detailCellLabel}>Avg HR</Text>
                  <Text style={styles.detailCellVal}>{localWorkout.avg_hr} bpm</Text>
                </View>
              )}
              {localWorkout.max_hr != null && (
                <View style={styles.detailCell}>
                  <Text style={styles.detailCellLabel}>Max HR</Text>
                  <Text style={styles.detailCellVal}>{localWorkout.max_hr} bpm</Text>
                </View>
              )}
              {localWorkout.pace_per_km != null && (
                <View style={styles.detailCell}>
                  <Text style={styles.detailCellLabel}>Pace</Text>
                  <Text style={styles.detailCellVal}>{formatPace(localWorkout.pace_per_km, imperial)}</Text>
                </View>
              )}
              {localWorkout.effort_zone && localWorkout.effort_zone !== 'unknown' && (
                <View style={styles.detailCell}>
                  <Text style={styles.detailCellLabel}>Effort Zone</Text>
                  <Text style={[styles.detailCellVal, { color: Colors.accent }]}>{localWorkout.effort_zone.toUpperCase()}</Text>
                </View>
              )}
              <View style={styles.detailCell}>
                <Text style={styles.detailCellLabel}>Source</Text>
                <Text style={styles.detailCellVal}>{localWorkout.source}</Text>
              </View>
            </View>

            {/* Activity type classification */}
            <Text style={[styles.detailSectionLabel, { marginTop: 8 }]}>WHAT WAS THIS SESSION?</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 20 }}>
              <View style={{ flexDirection: 'row', gap: 8, paddingBottom: 4 }}>
                {ACTIVITY_TYPES.map(type => {
                  const selected = activityType === type;
                  return (
                    <TouchableOpacity
                      key={type}
                      onPress={() => handleActivityType(type)}
                      style={[styles.activityChip, selected && styles.activityChipSelected]}
                    >
                      <Text style={[styles.activityChipText, selected && styles.activityChipTextSelected]}>
                        {type}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </ScrollView>

            {/* HR Zones */}
            {localWorkout.hr_zones ? (() => {
              try {
                const zones = JSON.parse(localWorkout.hr_zones) as Record<string, number>;
                const keys = ['z1', 'z2', 'z3', 'z4', 'z5'];
                const colors: Record<string, string> = { z1: '#4a9eff', z2: '#4affb8', z3: '#e8ff47', z4: '#ff9944', z5: '#ff4444' };
                return (
                  <>
                    <Text style={[styles.detailSectionLabel, { marginTop: 4 }]}>HR ZONES</Text>
                    <View style={{ gap: 8, marginBottom: 20 }}>
                      {keys.map(z => {
                        const mins = zones[z] ?? 0;
                        if (mins === 0) return null;
                        const total = keys.reduce((s, k) => s + (zones[k] ?? 0), 0);
                        const pct = total > 0 ? Math.round((mins / total) * 100) : 0;
                        return (
                          <View key={z} style={{ gap: 4 }}>
                            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                              <Text style={{ color: colors[z], fontSize: 12, fontWeight: '700' }}>{z.toUpperCase()}</Text>
                              <Text style={{ color: Colors.textSecondary, fontSize: 12 }}>{mins}m · {pct}%</Text>
                            </View>
                            <View style={{ height: 4, backgroundColor: '#222', borderRadius: 2 }}>
                              <View style={{ height: 4, width: `${pct}%` as any, backgroundColor: colors[z], borderRadius: 2 }} />
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  </>
                );
              } catch { return null; }
            })() : null}

            {/* HR upload */}
            {uploadStatus === 'loading' ? (
              <View style={{ alignItems: 'center', marginTop: 8, gap: 8, marginBottom: 12 }}>
                <ActivityIndicator color={Colors.accent} />
                <Text style={{ color: Colors.textSecondary, fontSize: 13 }}>Reading your HR data...</Text>
              </View>
            ) : (
              <TouchableOpacity
                style={[styles.saveBtn, { marginBottom: 12 }]}
                onPress={handleUploadHR}
              >
                <Text style={styles.saveBtnText}>
                  {localWorkout.hr_zones ? 'UPDATE HR DATA' : 'UPLOAD HR DATA'}
                </Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={styles.saveBtn}
              onPress={loadPrograms}
            >
              <Text style={styles.saveBtnText}>ASSIGN TO PROGRAM DAY</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function HistoryScreen() {
  const navigation = useNavigation<BottomTabNavigationProp<TabParamList>>();
  const [logs, setLogs]                   = useState<SessionLog[]>([]);
  const [externalWorkouts, setExternalWorkouts] = useState<ExternalWorkout[]>([]);
  const [checkins, setCheckins]           = useState<Checkin[]>([]);
  const [profile, setProfile]             = useState<{ fitness_goal: string; weight_unit: string; preferred_units: string | null } | null>(null);
  const [loading, setLoading]             = useState(true);
  const [checkinOpen, setCheckinOpen]     = useState(false);
  const [activeTab, setActiveTab]         = useState<'weight' | 'bodyfat'>('weight');
  const [selectedItem, setSelectedItem]   = useState<HistoryItem | null>(null);

  // Checkin form
  const [weightUnit, setWeightUnit] = useState<'lbs' | 'kg'>('lbs');
  const [weight, setWeight]         = useState('');
  const [bodyFat, setBodyFat]       = useState('');
  const [saving, setSaving]         = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    // Apply history_cache immediately for instant render
    let cacheApplied = false;
    try {
      const raw = await AsyncStorage.getItem('history_cache');
      if (raw && mounted.current) {
        const c = JSON.parse(raw);
        if (Date.now() - (c.timestamp ?? 0) < 4 * 60 * 60 * 1000) {
          if (c.profile) setProfile(c.profile);
          setLogs(c.logs ?? []);
          setExternalWorkouts(c.externalWorkouts ?? []);
          setCheckins(c.checkins ?? []);
          if (c.profile?.weight_unit) setWeightUnit(c.profile.weight_unit as 'lbs' | 'kg');
          setLoading(false);
          cacheApplied = true;
        }
      }
    } catch {}
    if (!cacheApplied) setLoading(true);

    const { data: { session } } = await supabase.auth.getSession();
    if (!mounted.current) { setLoading(false); return; }
    if (!session?.user) { setLoading(false); return; }

    const [profRes, logsRes, checkinsRes, extRes] = await Promise.all([
      supabase.from('profiles').select('fitness_goal, weight_unit, preferred_units').eq('id', session.user.id).single(),
      supabase.from('session_logs').select('*').eq('user_id', session.user.id)
        .order('completed_at', { ascending: false }),
      supabase.from('checkins').select('*').eq('user_id', session.user.id)
        .order('created_at', { ascending: true }).limit(20),
      supabase.from('external_workouts').select('*').eq('user_id', session.user.id)
        .order('start_time', { ascending: false }),
    ]);

    if (!mounted.current) { setLoading(false); return; }
    setProfile(profRes.data);
    setLogs(logsRes.data ?? []);
    setExternalWorkouts(extRes.data ?? []);
    setCheckins(checkinsRes.data ?? []);
    if (profRes.data?.weight_unit) setWeightUnit(profRes.data.weight_unit as 'lbs' | 'kg');
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleSaveCheckin() {
    const w = parseFloat(weight);
    if (isNaN(w) || w <= 0) return;
    setSaving(true);
    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) { setSaving(false); return; }
    const bf = parseFloat(bodyFat);
    await supabase.from('checkins').insert({
      user_id: authData.user.id,
      weight: w,
      weight_unit: weightUnit,
      body_fat_percentage: !isNaN(bf) && bf > 0 ? bf : null,
    });
    setWeight(''); setBodyFat('');
    setSaving(false);
    setCheckinOpen(false);
    await load();
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <ActivityIndicator color={Colors.accent} style={{ flex: 1 }} />
      </SafeAreaView>
    );
  }

  const showCheckin = !profile?.fitness_goal ||
    ['look_better', 'all_around'].includes(profile.fitness_goal);

  const totalSessions = logs.length;
  const best = longestStreak(logs);
  const imperial = (profile?.preferred_units ?? 'imperial') === 'imperial';

  const weightCheckins = checkins.filter(c => c.weight != null);
  const bfCheckins     = checkins.filter(c => c.body_fat_percentage != null);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Session detail modal */}
      {selectedItem?.kind === 'session' && (
        <SessionDetailModal log={selectedItem.data} onClose={() => setSelectedItem(null)} />
      )}
      {/* External workout detail modal */}
      {selectedItem?.kind === 'workout' && (
        <WorkoutDetailModal
          workout={selectedItem.data}
          imperial={imperial}
          onClose={() => setSelectedItem(null)}
          onAssigned={load}
        />
      )}

      {/* Check-in modal */}
      <Modal visible={checkinOpen} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Body Check-In</Text>

            <View style={styles.unitRow}>
              {(['lbs', 'kg'] as const).map(u => (
                <TouchableOpacity key={u}
                  style={[styles.unitBtn, weightUnit === u && styles.unitBtnActive]}
                  onPress={() => setWeightUnit(u)}>
                  <Text style={[styles.unitBtnText, weightUnit === u && { color: Colors.background }]}>{u}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <TextInput style={styles.input} placeholder={`Weight (${weightUnit})`}
              placeholderTextColor={Colors.textSecondary} value={weight} onChangeText={setWeight}
              keyboardType="decimal-pad" selectionColor={Colors.accent} />
            <TextInput style={[styles.input, { marginTop: 10 }]}
              placeholder="Body fat % (optional)"
              placeholderTextColor={Colors.textSecondary} value={bodyFat} onChangeText={setBodyFat}
              keyboardType="decimal-pad" selectionColor={Colors.accent} />

            <TouchableOpacity
              style={[styles.saveBtn, (!parseFloat(weight) || saving) && { opacity: 0.4 }]}
              onPress={handleSaveCheckin} disabled={!parseFloat(weight) || saving}>
              <Text style={styles.saveBtnText}>{saving ? 'SAVING...' : 'SAVE CHECK-IN'}</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={() => setCheckinOpen(false)} style={{ marginTop: 12 }}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
        <Text style={styles.heading}>HISTORY</Text>

        {/* Stats summary */}
        <View style={styles.statsRow}>
          {[
            { label: 'Sessions', val: String(totalSessions) },
            { label: 'Best Streak', val: `${best}d` },
            { label: 'Total Miles', val: '--' },
          ].map(s => (
            <View key={s.label} style={styles.statCard}>
              <Text style={styles.statVal}>{s.val}</Text>
              <Text style={styles.statLabel}>{s.label}</Text>
            </View>
          ))}
        </View>

        {/* Check-in card */}
        {showCheckin && (
          <View style={styles.card}>
            <View style={styles.checkinCardRow}>
              <View>
                <Text style={styles.cardTitle}>Body Check-In</Text>
                <Text style={styles.cardSub}>
                  Log your weight and body fat % to track progress
                </Text>
              </View>
              <TouchableOpacity style={styles.logBtn} onPress={() => setCheckinOpen(true)}>
                <Text style={styles.logBtnText}>LOG</Text>
              </TouchableOpacity>
            </View>

            {checkins.length > 0 && (
              <>
                <View style={styles.tabRow}>
                  {[
                    { key: 'weight', label: 'Weight' },
                    { key: 'bodyfat', label: 'Body Fat %' },
                  ].map(t => (
                    <TouchableOpacity key={t.key}
                      style={[styles.tab, activeTab === t.key && styles.tabActive]}
                      onPress={() => setActiveTab(t.key as 'weight' | 'bodyfat')}>
                      <Text style={[styles.tabText, activeTab === t.key && { color: Colors.background }]}>
                        {t.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                {activeTab === 'weight' ? (
                  <BarChart
                    values={weightCheckins.map(c => c.weight as number)}
                    labels={weightCheckins.map(c => fmtDateShort(c.created_at))}
                    unit={weightUnit}
                  />
                ) : (
                  <BarChart
                    values={bfCheckins.map(c => c.body_fat_percentage as number)}
                    labels={bfCheckins.map(c => fmtDateShort(c.created_at))}
                    unit="%"
                  />
                )}
              </>
            )}
          </View>
        )}

        {/* Sessions + External Workouts — interleaved by date */}
        <Text style={styles.sectionHeading}>SESSIONS</Text>
        {logs.length === 0 && externalWorkouts.length === 0 ? (
          <View style={styles.emptyState}>
            <Feather name="activity" color={Colors.textSecondary} size={32} />
            <Text style={styles.emptyStateTitle}>No sessions yet</Text>
            <Text style={styles.emptyStateText}>Complete your first workout to start tracking progress.</Text>
            <TouchableOpacity style={styles.emptyStateBtn} onPress={() => navigation.navigate('Program' as any)}>
              <Text style={styles.emptyStateBtnText}>View Program</Text>
            </TouchableOpacity>
          </View>
        ) : (() => {
          const items: HistoryItem[] = [
            ...logs.map(l => ({ kind: 'session' as const, data: l })),
            ...externalWorkouts.map(w => ({ kind: 'workout' as const, data: w })),
          ].sort((a, b) => {
            const da = a.kind === 'session' ? a.data.completed_at : a.data.start_time;
            const db = b.kind === 'session' ? b.data.completed_at : b.data.start_time;
            return new Date(db).getTime() - new Date(da).getTime();
          });

          return (
            <View style={styles.logList}>
              {items.map(item => {
                if (item.kind === 'session') {
                  const log = item.data;
                  return (
                    <TouchableOpacity
                      key={`s-${log.id}`}
                      style={styles.logCard}
                      onPress={() => setSelectedItem(item)}
                      activeOpacity={0.75}
                    >
                      <View style={styles.logRow}>
                        <View>
                          <Text style={styles.logDate}>{fmtDateShort(log.completed_at)}</Text>
                          <Text style={styles.logType}>{getSessionTitle(log)}</Text>
                        </View>
                        <View style={styles.logMeta}>
                          {log.duration != null && (
                            <Text style={styles.logDuration}>{fmtDuration(log.duration)}</Text>
                          )}
                          {log.rpe != null && (
                            <View style={[styles.rpeBadge, { backgroundColor: rpeColor(log.rpe) + '22' }]}>
                              <Text style={[styles.rpeBadgeText, { color: rpeColor(log.rpe) }]}>
                                RPE {log.rpe}
                              </Text>
                            </View>
                          )}
                          <Feather name="chevron-right" color={Colors.textSecondary} size={18} />
                        </View>
                      </View>
                    </TouchableOpacity>
                  );
                }

                const w = item.data;
                return (
                  <TouchableOpacity
                    key={`w-${w.id}`}
                    style={[styles.logCard, styles.extWorkoutCard]}
                    onPress={() => setSelectedItem(item)}
                    activeOpacity={0.75}
                  >
                    <View style={styles.logRow}>
                      <View style={{ gap: 2 }}>
                        <Text style={styles.logDate}>{fmtDateShort(w.start_time)}</Text>
                        <Text style={styles.logType}>
                          {WORKOUT_TYPE_LABELS[w.workout_type] ?? w.workout_type}
                        </Text>
                        <Text style={styles.extWorkoutSrc}>{w.source}</Text>
                      </View>
                      <View style={styles.logMeta}>
                        <Text style={styles.logDuration}>{w.duration_minutes}m</Text>
                        {w.calories != null && (
                          <Text style={styles.logDuration}>{w.calories} kcal</Text>
                        )}
                        <View style={styles.offProgramBadge}>
                          <Text style={styles.offProgramText}>OFF-PROGRAM</Text>
                        </View>
                        <Feather name="chevron-right" color={Colors.textSecondary} size={18} />
                      </View>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          );
        })()}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  heading: { color: Colors.textPrimary, fontSize: 24, fontWeight: '800', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12 },
  sectionHeading: {
    color: Colors.textSecondary, fontSize: 11, fontWeight: '700', letterSpacing: 1.5,
    textTransform: 'uppercase', paddingHorizontal: 20, marginTop: 20, marginBottom: 10,
  },
  emptyText: { color: Colors.textSecondary, fontSize: 14, textAlign: 'center', paddingHorizontal: 20, paddingVertical: 24 },

  statsRow: { flexDirection: 'row', paddingHorizontal: 16, gap: 10, marginBottom: 16 },
  statCard: { flex: 1, backgroundColor: Colors.card, borderRadius: 12, padding: 14, alignItems: 'center' },
  statVal: { color: Colors.textPrimary, fontFamily: Fonts.metric, fontSize: 26, marginBottom: 2 },
  statLabel: { color: Colors.textSecondary, fontSize: 11, fontWeight: '600' },

  card: { marginHorizontal: 16, backgroundColor: Colors.card, borderRadius: 14, padding: 16, marginBottom: 10 },
  checkinCardRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 },
  cardTitle: { color: Colors.textPrimary, fontSize: 15, fontWeight: '700', marginBottom: 4 },
  cardSub: { color: Colors.textSecondary, fontSize: 12, maxWidth: '80%' },
  logBtn: { backgroundColor: Colors.accent, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  logBtnText: { color: Colors.background, fontSize: 12, fontWeight: '700' },

  // Chart tabs
  tabRow: {
    flexDirection: 'row', backgroundColor: Colors.nested, borderRadius: 8,
    padding: 3, gap: 3, marginBottom: 12,
  },
  tab: { flex: 1, paddingVertical: 7, alignItems: 'center', borderRadius: 6 },
  tabActive: { backgroundColor: Colors.accent },
  tabText: { color: Colors.textSecondary, fontSize: 13, fontWeight: '600' },

  // Chart
  chartEmpty: { paddingVertical: 20, alignItems: 'center' },
  chartEmptyText: { color: Colors.textSecondary, fontSize: 13 },
  barsRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingBottom: 4, minHeight: BAR_MAX_H + 40 },
  barCol: { width: 44, alignItems: 'center', gap: 4 },
  bar: { width: 28, backgroundColor: Colors.accent, borderRadius: 4, minHeight: 4 },
  barVal: { color: Colors.textSecondary, fontFamily: Fonts.metric, fontSize: 10, textAlign: 'center' },
  barLabel: { color: Colors.textSecondary, fontSize: 10, textAlign: 'center' },
  barUnit: { color: Colors.textSecondary, fontSize: 11, textAlign: 'right', marginTop: 4 },

  // Session log list
  logList: { paddingHorizontal: 16, gap: 8 },
  logCard: { backgroundColor: Colors.card, borderRadius: 12, padding: 14 },
  logRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  logDate: { color: Colors.textSecondary, fontSize: 12, marginBottom: 2 },
  logType: { color: Colors.textPrimary, fontSize: 15, fontWeight: '600' },
  logMeta: { alignItems: 'flex-end', gap: 4 },
  logDuration: { color: Colors.textSecondary, fontSize: 13 },
  rpeBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  rpeBadgeText: { fontSize: 12, fontWeight: '700' },

  // External workout entries
  extWorkoutCard: { borderLeftWidth: 2, borderLeftColor: ORANGE },
  extWorkoutSrc: { color: Colors.textSecondary, fontSize: 11 },
  offProgramBadge: {
    backgroundColor: '#ff994422', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3,
  },
  offProgramText: { color: ORANGE, fontSize: 11, fontWeight: '700' },

  // Detail modal
  detailBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'flex-end' },
  detailSheet: {
    backgroundColor: Colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 24, paddingBottom: 48, maxHeight: '80%',
  },
  detailHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6,
  },
  detailTitle: { color: Colors.textPrimary, fontSize: 20, fontWeight: '800', flex: 1, marginRight: 12 },
  detailOffBadge: { color: ORANGE, fontSize: 10, fontWeight: '700', letterSpacing: 1, marginBottom: 2 },
  detailCloseBtn: { padding: 4 },
  detailDate: { color: Colors.textSecondary, fontSize: 13, marginBottom: 20 },
  detailGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 },
  detailCell: {
    backgroundColor: Colors.nested, borderRadius: 10, padding: 12, minWidth: '45%', flex: 1,
  },
  detailCellLabel: { color: Colors.textSecondary, fontSize: 11, fontWeight: '600', marginBottom: 4, letterSpacing: 0.5 },
  detailCellVal: { color: Colors.textPrimary, fontFamily: Fonts.metric, fontSize: 20 },
  detailSectionLabel: {
    color: Colors.accent, fontSize: 11, fontWeight: '700', letterSpacing: 1,
    textTransform: 'uppercase', marginBottom: 8,
  },
  detailNotes: { color: Colors.textPrimary, fontSize: 14, lineHeight: 20 },

  // Check-in modal
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: Colors.card, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 24, paddingBottom: 40,
  },
  modalTitle: { color: Colors.textPrimary, fontSize: 18, fontWeight: '700', marginBottom: 16, textAlign: 'center' },
  unitRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  unitBtn: {
    flex: 1, backgroundColor: Colors.nested, borderWidth: 1, borderColor: Colors.border,
    borderRadius: 10, paddingVertical: 12, alignItems: 'center',
  },
  unitBtnActive: { backgroundColor: Colors.accent, borderColor: Colors.accent },
  unitBtnText: { color: Colors.textPrimary, fontSize: 15, fontWeight: '600' },
  input: {
    backgroundColor: Colors.nested, borderWidth: 1, borderColor: Colors.border,
    borderRadius: 10, paddingHorizontal: 16, paddingVertical: 14,
    color: Colors.textPrimary, fontSize: 16,
  },
  saveBtn: {
    backgroundColor: Colors.accent, borderRadius: 10, paddingVertical: 16,
    alignItems: 'center', marginTop: 14,
  },
  saveBtnText: { color: Colors.background, fontSize: 16, fontWeight: '700' },
  cancelText: { color: Colors.textSecondary, fontSize: 15, textAlign: 'center' },

  // Empty state
  emptyState:        { alignItems: 'center', paddingVertical: 40, gap: 8 },
  emptyStateTitle:   { color: Colors.textPrimary, fontSize: 16, fontWeight: '600', marginTop: 4 },
  emptyStateText:    { color: Colors.textSecondary, fontSize: 13, textAlign: 'center', paddingHorizontal: 20 },
  emptyStateBtn:     { marginTop: 8, backgroundColor: Colors.accent, borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  emptyStateBtnText: { color: '#080808', fontWeight: '700', fontSize: 14 },

  // Activity type chips
  activityChip: {
    borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8,
    backgroundColor: Colors.nested, borderWidth: 1, borderColor: Colors.border,
  },
  activityChipSelected: {
    backgroundColor: Colors.accent, borderColor: Colors.accent,
  },
  activityChipText: { color: Colors.textSecondary, fontSize: 13, fontWeight: '600' },
  activityChipTextSelected: { color: Colors.background },
});
