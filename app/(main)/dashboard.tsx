import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { supabase } from '../../lib/supabase';
import type { MainStackParamList } from '../_layout';

type Props = NativeStackScreenProps<MainStackParamList, 'Dashboard'>;

export default function DashboardScreen(_props: Props) {
  async function handleLogout() {
    await supabase.auth.signOut();
    // onAuthStateChange in _layout.tsx will switch back to AuthNavigator
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Dashboard</Text>
        <Text style={styles.subtitle}>Welcome to Peak 65</Text>
      </View>

      <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
        <Text style={styles.logoutText}>Log Out</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#080808',
    paddingHorizontal: 24,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontSize: 36,
    fontWeight: '800',
    color: '#f0ede8',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#8a877f',
  },
  logoutButton: {
    backgroundColor: '#e8ff47',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 16,
  },
  logoutText: {
    color: '#080808',
    fontSize: 16,
    fontWeight: '700',
  },
});
