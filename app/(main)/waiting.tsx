import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../../lib/theme';






export default function WaitingScreen() {
  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <Text style={styles.logo}>Peak 65</Text>
      <View style={styles.body}>
        <Text style={styles.heading}>You're all set.</Text>
        <Text style={styles.subtext}>
          Dakota is reviewing your profile and building your program personally. You'll hear from him within 48 hours.
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
