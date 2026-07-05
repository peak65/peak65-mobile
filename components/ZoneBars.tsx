import React from 'react';
import { View, Text } from 'react-native';
import { Colors } from '../lib/theme';

// Already-parsed zone_minutes object ({z1..z5} minutes). Do NOT pass a JSON string.
export type ZoneMinutes = {
  z1?: number | null;
  z2?: number | null;
  z3?: number | null;
  z4?: number | null;
  z5?: number | null;
};

const ZONE_KEYS = ['z1', 'z2', 'z3', 'z4', 'z5'] as const;
const ZONE_COLORS: Record<string, string> = {
  z1: '#4a9eff', z2: '#4affb8', z3: '#e8ff47', z4: '#ff9944', z5: '#ff4444',
};

// Zone distribution bars. Reuses the same minute→percent logic and colors as
// History's inline renderer, but takes an already-parsed object so it can be
// fed zone_minutes (jsonb) directly.
export default function ZoneBars({ zones }: { zones: ZoneMinutes | null | undefined }) {
  if (!zones) return null;
  const total = ZONE_KEYS.reduce((s, k) => s + (zones[k] ?? 0), 0);
  if (total <= 0) return null;

  return (
    <View style={{ gap: 8 }}>
      {ZONE_KEYS.map(z => {
        const mins = zones[z] ?? 0;
        if (mins === 0) return null;
        const pct = Math.round((mins / total) * 100);
        return (
          <View key={z} style={{ gap: 4 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ color: ZONE_COLORS[z], fontSize: 12, fontWeight: '700' }}>{z.toUpperCase()}</Text>
              <Text style={{ color: Colors.textSecondary, fontSize: 12 }}>{mins}m · {pct}%</Text>
            </View>
            <View style={{ height: 4, backgroundColor: '#222', borderRadius: 2 }}>
              <View style={{ height: 4, width: `${pct}%` as any, backgroundColor: ZONE_COLORS[z], borderRadius: 2 }} />
            </View>
          </View>
        );
      })}
    </View>
  );
}
