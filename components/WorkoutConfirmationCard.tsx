import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { confirmMatch, snoozeCandidate } from '../lib/sessionMatcher';
import type { CandidateRow } from '../lib/sessionMatcher';

const YELLOW    = '#e8ff47';
const BLACK     = '#080808';
const OFF_WHITE = '#f0ede8';
const GREY      = '#8a877f';
const CARD_BG   = '#111111';

const WORKOUT_TYPE_LABELS: Record<string, string> = {
  run:      'Run',
  bike:     'Cycling',
  strength: 'Strength',
  hiit:     'HIIT',
  swim:     'Swim',
  row:      'Row',
  hike:     'Hike',
  walk:     'Walk',
  other:    'Workout',
};

type Props = {
  candidate: CandidateRow;
  todaySessionNames: string[];
  onResolved: () => void;
};

export default function WorkoutConfirmationCard({
  candidate,
  todaySessionNames,
  onResolved,
}: Props) {
  const [mode, setMode]       = useState<'ask' | 'choose'>('ask');
  const [loading, setLoading] = useState(false);

  const workoutLabel = WORKOUT_TYPE_LABELS[candidate.workout_type ?? ''] ?? 'Workout';
  const duration     = candidate.duration_minutes ?? '?';
  const source       = candidate.source ?? 'Wearable';

  async function handleConfirm(sessionName?: string) {
    setLoading(true);
    try {
      await confirmMatch(candidate.id, sessionName);
    } finally {
      onResolved();
    }
  }

  async function handleSnooze() {
    setLoading(true);
    try {
      await snoozeCandidate(candidate.id);
    } finally {
      onResolved();
    }
  }

  if (loading) {
    return (
      <View style={styles.card}>
        <ActivityIndicator color={YELLOW} />
      </View>
    );
  }

  if (mode === 'choose') {
    return (
      <View style={styles.card}>
        <Text style={styles.label}>WHICH SESSION WAS THIS?</Text>
        <Text style={styles.subLabel}>{workoutLabel} · {duration} min · {source}</Text>
        {todaySessionNames.map(name => (
          <TouchableOpacity
            key={name}
            style={styles.sessionChip}
            onPress={() => handleConfirm(name)}
          >
            <Text style={styles.sessionChipText}>{name}</Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity style={styles.skipBtn} onPress={handleSnooze}>
          <Text style={styles.skipText}>SKIP FOR NOW</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <Text style={styles.label}>MATCH WORKOUT</Text>
      <Text style={styles.workoutLine}>
        {workoutLabel} · {duration} min · {source}
      </Text>
      {candidate.program_session_name ? (
        <Text style={styles.matchLine}>
          Looks like:{' '}
          <Text style={styles.sessionName}>{candidate.program_session_name}</Text>
        </Text>
      ) : null}
      <View style={styles.btnRow}>
        <TouchableOpacity style={styles.confirmBtn} onPress={() => handleConfirm()}>
          <Text style={styles.confirmBtnText}>YES, THAT'S IT</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.alternateBtn} onPress={() => setMode('choose')}>
          <Text style={styles.alternateBtnText}>DIFFERENT SESSION</Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity style={styles.skipBtn} onPress={handleSnooze}>
        <Text style={styles.skipText}>SKIP FOR NOW</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginBottom: 12,
    backgroundColor: CARD_BG,
    borderRadius: 16,
    padding: 16,
    borderLeftWidth: 3,
    borderLeftColor: YELLOW,
    minHeight: 60,
    justifyContent: 'center',
  },
  label: {
    color: YELLOW,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginBottom: 4,
  },
  subLabel: {
    color: GREY,
    fontSize: 13,
    marginBottom: 12,
  },
  workoutLine: {
    color: OFF_WHITE,
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  matchLine: {
    color: GREY,
    fontSize: 13,
    marginBottom: 14,
  },
  sessionName: {
    color: OFF_WHITE,
    fontWeight: '600',
  },
  btnRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  confirmBtn: {
    flex: 1,
    backgroundColor: YELLOW,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  confirmBtnText: {
    color: BLACK,
    fontSize: 13,
    fontWeight: '700',
  },
  alternateBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: GREY,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  alternateBtnText: {
    color: OFF_WHITE,
    fontSize: 13,
    fontWeight: '600',
  },
  sessionChip: {
    borderWidth: 1,
    borderColor: GREY,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    marginBottom: 8,
    alignItems: 'center',
  },
  sessionChipText: {
    color: OFF_WHITE,
    fontSize: 14,
    fontWeight: '600',
  },
  skipBtn: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  skipText: {
    color: GREY,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
});
