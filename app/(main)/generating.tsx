import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { supabase } from '../../lib/supabase';
import type { MainStackParamList } from '../_layout';
import { Colors, Fonts } from '../../lib/theme';
import { Logo } from '../../components/Logo';

type Props = NativeStackScreenProps<MainStackParamList, 'Generating'>;

const MESSAGES = [
  'Analyzing your profile...',
  'Mapping your training history...',
  'Designing your assessment week...',
  'Writing your coaching cues...',
  'Calibrating to your goals...',
  'Almost ready...',
];

const MSG_VISIBLE_MS  = 3000;
const MSG_FADE_IN_MS  = 600;
const MSG_FADE_OUT_MS = 400;
const PROGRESS_TOTAL_MS = 90_000;

export default function GeneratingScreen({ navigation }: Props) {
  const [msgIdx, setMsgIdx] = useState(0);
  const [error, setError]   = useState(false);
  const [barWidth, setBarWidth] = useState(0);

  const msgOpacity  = useRef(new Animated.Value(0)).current;
  const progressVal = useRef(new Animated.Value(0)).current;
  const cycleAnim   = useRef<Animated.CompositeAnimation | null>(null);
  const progressAnim = useRef<Animated.CompositeAnimation | null>(null);
  const alive       = useRef(true);

  // ── Animated message cycling ─────────────────────────────────────────────────

  function cycleMessages(idx: number) {
    if (!alive.current) return;
    setMsgIdx(idx);
    const seq = Animated.sequence([
      Animated.timing(msgOpacity, { toValue: 1, duration: MSG_FADE_IN_MS,  useNativeDriver: true }),
      Animated.delay(MSG_VISIBLE_MS),
      Animated.timing(msgOpacity, { toValue: 0, duration: MSG_FADE_OUT_MS, useNativeDriver: true }),
    ]);
    cycleAnim.current = seq;
    seq.start(({ finished }) => {
      if (finished && alive.current) cycleMessages((idx + 1) % MESSAGES.length);
    });
  }

  useEffect(() => {
    alive.current = true;
    cycleMessages(0);

    const prog = Animated.timing(progressVal, {
      toValue: 1,
      duration: PROGRESS_TOTAL_MS,
      useNativeDriver: false,
    });
    progressAnim.current = prog;
    prog.start();

    return () => {
      alive.current = false;
      cycleAnim.current?.stop();
      progressAnim.current?.stop();
    };
  }, []);

  // Stop animations on error
  useEffect(() => {
    if (error) {
      cycleAnim.current?.stop();
      progressAnim.current?.stop();
    }
  }, [error]);

  // ── API call ─────────────────────────────────────────────────────────────────

  const generate = useCallback(async () => {
    setError(false);

    const { data: authData } = await supabase.auth.getUser();
    const userId = authData.user?.id;
    if (!userId) { setError(true); return; }

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 120_000);

    try {
      const res = await fetch('https://peak65.vercel.app/api/generate-assessment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ userId }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      navigation.replace('Tabs');
    } catch (err) {
      clearTimeout(timeout);
      console.log('[generating] error:', timedOut ? 'timeout' : JSON.stringify(err));
      setError(true);
    }
  }, [navigation]);

  useEffect(() => { generate(); }, [generate]);

  // ── Render ───────────────────────────────────────────────────────────────────

  const animatedBarWidth = progressVal.interpolate({
    inputRange:  [0, 1],
    outputRange: [0, barWidth],
  });

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <Logo width={160} />

      <View style={styles.body}>
        <Text style={styles.heading}>Building your program</Text>

        {error ? (
          <TouchableOpacity onPress={generate} style={styles.retryBtn}>
            <Text style={styles.retryText}>Something went wrong. Tap to try again.</Text>
          </TouchableOpacity>
        ) : (
          <Animated.Text style={[styles.message, { opacity: msgOpacity }]}>
            {MESSAGES[msgIdx]}
          </Animated.Text>
        )}
      </View>

      {/* Progress bar */}
      <View
        style={styles.progressTrack}
        onLayout={e => setBarWidth(e.nativeEvent.layout.width)}
      >
        <Animated.View style={[styles.progressFill, { width: animatedBarWidth }]} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: Colors.background, paddingHorizontal: 24,
  },

  logo: {
    color: Colors.accent, fontSize: 32, fontFamily: Fonts.metricHeavy,
    textAlign: 'center', letterSpacing: -1, paddingTop: 8,
  },

  body: {
    flex: 1, alignItems: 'center', justifyContent: 'center', gap: 28,
  },

  heading: {
    color: Colors.textPrimary, fontSize: 18, fontWeight: '600',
    textAlign: 'center', letterSpacing: 0.2,
  },

  message: {
    color: Colors.accent, fontSize: 26, fontFamily: Fonts.metric,
    textAlign: 'center', letterSpacing: -0.3, lineHeight: 34,
  },

  retryBtn: { paddingVertical: 8, paddingHorizontal: 16 },
  retryText: {
    color: Colors.accent, fontSize: 15, textAlign: 'center', textDecorationLine: 'underline',
  },

  progressTrack: {
    height: 2, backgroundColor: Colors.nested, borderRadius: 1,
    marginBottom: 24, overflow: 'hidden',
  },
  progressFill: {
    height: 2, backgroundColor: Colors.accent, borderRadius: 1,
  },
});
