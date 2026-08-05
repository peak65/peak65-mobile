import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../../lib/theme';
import { Logo } from '../../components/Logo';

// Stage 1 placeholder. The real Pinnacle setup (birthday, race dates, Whoop
// ask) lands here in Stage 2 — for now this only needs to render as a valid
// destination for the 'setup' app state.

export default function PinnacleSetupScreen() {
  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <Logo width={90} />
      <View style={styles.body}>
        <Text style={styles.heading}>Let's get you set up.</Text>
        <Text style={styles.subtext}>One moment…</Text>
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
});
