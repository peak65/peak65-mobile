import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '../../lib/supabase';
import { Colors } from '../../lib/theme';
import { Logo } from '../../components/Logo';

const FALLBACK_COACH_NAME = 'Your coach';






export default function WaitingScreen() {
  const [coachName, setCoachName] = useState(FALLBACK_COACH_NAME);

  // Resolve the athlete's actual coach: coach_athletes → coach_id → profiles.
  // Same two-step lookup the Messages screen uses. Any failure leaves the
  // generic fallback in place rather than naming the wrong person.
  useEffect(() => {
    let active = true;

    async function loadCoach() {
      const { data: { session } } = await supabase.auth.getSession();
      const uid = session?.user?.id;
      if (!uid) return;

      const { data: ca } = await supabase
        .from('coach_athletes')
        .select('coach_id')
        .eq('athlete_id', uid)
        .eq('status', 'active')
        .maybeSingle();
      if (!ca?.coach_id) return;

      const { data: p } = await supabase
        .from('profiles')
        .select('first_name, last_name')
        .eq('id', ca.coach_id)
        .maybeSingle();

      const firstName = (p?.first_name ?? '').trim();
      if (active && firstName) setCoachName(firstName);
    }

    loadCoach().catch(() => {});
    return () => { active = false; };
  }, []);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <Logo width={90} />
      <View style={styles.body}>
        <Text style={styles.heading}>You're all set.</Text>
        <Text style={styles.subtext}>
          {coachName} is reviewing your profile and building your program personally. You'll hear from them within 48 hours.
        </Text>
        <Text style={styles.footnote}>Questions? Reply to your welcome email.</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
    alignItems: 'center',
  },
  logo: {
    color: Colors.accent,
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.5,
    marginTop: 8,
  },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 20,
  },
  heading: {
    color: Colors.textPrimary,
    fontSize: 28,
    fontWeight: '600',
    textAlign: 'center',
  },
  subtext: {
    color: Colors.textSecondary,
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
    maxWidth: 280,
  },
  footnote: {
    color: Colors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
  },
});
