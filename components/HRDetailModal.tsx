import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, ActivityIndicator, Modal, Image,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { Colors, Fonts } from '../lib/theme';
import ZoneBars, { type ZoneMinutes } from './ZoneBars';

// Rich HR data carried alongside each completed session, so a completed row can
// open a read-only HR detail view. All fields nullable except id (older
// completed sessions were logged before any HR upload existed).
export type HRDetail = {
  id: string;
  peak_hr: number | null;
  avg_hr: number | null;
  hr_recovery_1min: number | null;
  hr_recovery_2min: number | null;
  zone_minutes: ZoneMinutes | null;
  hr_screenshot_url: string | null;
  hr_curve_screenshot_url: string | null;
};

// ─── HR detail modal (read-only: image + numbers + zones, no feedback) ─────────

export default function HRDetailModal({ detail, onClose }: { detail: HRDetail; onClose: () => void }) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!detail.hr_screenshot_url) { setImgFailed(true); return; }
      try {
        const { data, error } = await supabase.storage
          .from('hr-screenshots')
          .createSignedUrl(detail.hr_screenshot_url, 3600);
        if (!active) return;
        if (error || !data?.signedUrl) { setImgFailed(true); return; }
        setSignedUrl(data.signedUrl);
      } catch {
        if (active) setImgFailed(true);
      }
    })();
    return () => { active = false; };
  }, [detail.hr_screenshot_url]);

  const hasZones = !!detail.zone_minutes &&
    (['z1', 'z2', 'z3', 'z4', 'z5'] as const).reduce((s, k) => s + (detail.zone_minutes?.[k] ?? 0), 0) > 0;

  const statCell = (label: string, val: number | null) => (
    <View style={pd.hrStatCell}>
      <Text style={pd.hrStatLabel}>{label}</Text>
      <Text style={pd.hrStatVal}>{val != null ? `${val} bpm` : '--'}</Text>
    </View>
  );

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={pd.hrOverlay}>
        <View style={pd.hrCard}>
          <View style={pd.hrHeader}>
            <Text style={pd.hrTitle}>HEART RATE</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Feather name="x" color={Colors.textSecondary} size={22} />
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 16, paddingBottom: 8 }}>
            {/* Screenshot (signed from private bucket) or graceful placeholder */}
            {signedUrl && !imgFailed ? (
              <Image
                source={{ uri: signedUrl }}
                style={pd.hrImage}
                resizeMode="contain"
                onError={() => setImgFailed(true)}
              />
            ) : imgFailed ? (
              <View style={pd.hrPlaceholder}>
                <Feather name="image" color={Colors.textSecondary} size={20} />
                <Text style={pd.hrPlaceholderTxt}>No HR uploaded for this session</Text>
              </View>
            ) : (
              <View style={pd.hrPlaceholder}>
                <ActivityIndicator color={Colors.accent} />
              </View>
            )}

            {/* Extracted numbers */}
            <View style={pd.hrStatRow}>
              {statCell('PEAK HR', detail.peak_hr)}
              {statCell('AVG HR', detail.avg_hr)}
            </View>
            <View style={pd.hrStatRow}>
              {statCell('1-MIN REC', detail.hr_recovery_1min)}
              {statCell('2-MIN REC', detail.hr_recovery_2min)}
            </View>

            {/* Zone distribution */}
            {hasZones && (
              <View style={{ gap: 10 }}>
                <Text style={pd.hrSectionLabel}>ZONE DISTRIBUTION</Text>
                <ZoneBars zones={detail.zone_minutes} />
              </View>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const pd = StyleSheet.create({
  // ── HR detail modal ──────────────────────────────────────────────────────────
  hrOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'flex-end',
  },
  hrCard: {
    backgroundColor: Colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16,
    padding: 20, paddingBottom: 28, maxHeight: '88%',
  },
  hrHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 16,
  },
  hrTitle: {
    color: Colors.accent, fontSize: 14, fontWeight: '700', letterSpacing: 2,
    fontFamily: Fonts.metric,
  },
  hrImage: {
    width: '100%', height: 260, borderRadius: 8, backgroundColor: Colors.nested,
  },
  hrPlaceholder: {
    width: '100%', height: 120, borderRadius: 8, backgroundColor: Colors.nested,
    alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  hrPlaceholderTxt: { color: Colors.textSecondary, fontSize: 13 },
  hrStatRow: { flexDirection: 'row', gap: 12 },
  hrStatCell: {
    flex: 1, backgroundColor: Colors.nested, borderRadius: 8, padding: 14, gap: 4,
  },
  hrStatLabel: {
    color: Colors.textSecondary, fontSize: 11, fontWeight: '700', letterSpacing: 1,
  },
  hrStatVal: { color: Colors.textPrimary, fontSize: 20, fontFamily: Fonts.metric },
  hrSectionLabel: {
    color: Colors.accent, fontSize: 12, fontWeight: '700', letterSpacing: 2,
  },
});
