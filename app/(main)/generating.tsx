import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { supabase } from '../../lib/supabase';
import type { MainStackParamList } from '../_layout';

type Props = NativeStackScreenProps<MainStackParamList, 'Generating'>;

const YELLOW    = '#e8ff47';
const BLACK     = '#080808';
const OFF_WHITE = '#f0ede8';
const GREY      = '#8a877f';

const MESSAGES = [
  'Analyzing your profile...',
  'Designing your assessment week...',
  'Calibrating your zones...',
  'Almost ready...',
];

export default function GeneratingScreen({ navigation }: Props) {
  const [msgIdx, setMsgIdx]   = useState(0);
  const [error, setError]     = useState(false);
  const [loading, setLoading] = useState(true);

  const generate = useCallback(async () => {
    setError(false);
    setLoading(true);

    const { data: authData } = await supabase.auth.getUser();
    const userId = authData.user?.id;
    if (!userId) { setError(true); setLoading(false); return; }

    const controller  = new AbortController();
    let   timedOut    = false;
    const timeout     = setTimeout(() => {
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
      setLoading(false);
    }
  }, [navigation]);

  useEffect(() => { generate(); }, [generate]);

  useEffect(() => {
    if (!loading || error) return;
    const id = setInterval(() => setMsgIdx(i => (i + 1) % MESSAGES.length), 3000);
    return () => clearInterval(id);
  }, [loading, error]);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <Text style={styles.logo}>Peak 65</Text>
      <View style={styles.body}>
        {loading && !error && (
          <ActivityIndicator size="large" color={YELLOW} style={{ marginBottom: 28 }} />
        )}
        <Text style={styles.title}>Building your program...</Text>
        {error ? (
          <TouchableOpacity onPress={generate} style={styles.retryBtn}>
            <Text style={styles.retryText}>Something went wrong. Tap to try again.</Text>
          </TouchableOpacity>
        ) : (
          <Text style={styles.subtitle}>{MESSAGES[msgIdx]}</Text>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BLACK, paddingHorizontal: 24 },
  logo: {
    color: YELLOW, fontSize: 36, fontWeight: '800',
    textAlign: 'center', letterSpacing: -1, paddingTop: 8,
  },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { color: OFF_WHITE, fontSize: 22, fontWeight: '700', textAlign: 'center', marginBottom: 12 },
  subtitle: { color: GREY, fontSize: 15, textAlign: 'center' },
  retryBtn: { marginTop: 8, paddingVertical: 8, paddingHorizontal: 16 },
  retryText: { color: YELLOW, fontSize: 15, textAlign: 'center', textDecorationLine: 'underline' },
});
