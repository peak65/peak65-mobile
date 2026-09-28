import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { WifiOff } from 'lucide-react-native';
import { Colors } from '../lib/theme';

// The final state for a load that failed with nothing on screen. A spinner means
// a request is in flight; this means it isn't, and says what to do next.
export default function LoadFailedCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={styles.card}>
      <WifiOff color={Colors.textSecondary} size={22} strokeWidth={1.75} />
      <Text style={styles.message}>{message}</Text>
      <TouchableOpacity style={styles.retryBtn} onPress={onRetry} activeOpacity={0.85}>
        <Text style={styles.retryText}>Retry</Text>
      </TouchableOpacity>
    </View>
  );
}

// Small inline version for when cached content stays on screen: replaces the
// "Refreshing…" label once the refresh has failed.
export function RefreshFailedLabel({ onRetry, style }: { onRetry: () => void; style?: object }) {
  return (
    <TouchableOpacity onPress={onRetry} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={style}>
      <Text style={styles.inlineText}>Couldn't refresh · <Text style={styles.inlineRetry}>Retry</Text></Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    alignItems: 'center',
    gap: 10,
    backgroundColor: Colors.card,
    borderRadius: 14,
    paddingVertical: 24,
    paddingHorizontal: 20,
    marginHorizontal: 16,
    marginVertical: 12,
  },
  message: {
    color: Colors.textPrimary,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  retryBtn: {
    backgroundColor: Colors.accent,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 28,
    marginTop: 4,
  },
  retryText: { color: Colors.background, fontSize: 14, fontWeight: '700' },
  inlineText: { color: Colors.textSecondary, fontSize: 10 },
  inlineRetry: { color: Colors.accent, fontWeight: '700' },
});
