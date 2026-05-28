import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, Image,
  Animated, Alert, StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import type { ProgramSession } from '../app/_layout';
import { supabase } from '../lib/supabase';

type PickedImage = { base64: string; uri: string };

async function pickImage(): Promise<PickedImage | null> {
  let ImagePicker: any;
  try { ImagePicker = require('expo-image-picker'); } catch {
    Alert.alert('Not available', 'expo-image-picker is not installed.');
    return null;
  }
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    Alert.alert(
      'Photo library access required',
      'Go to Settings and allow Peak 65 to access your photos.',
      [{ text: 'OK' }],
    );
    return null;
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    base64: true,
    quality: 0.85,
  });
  if (result.canceled || !result.assets?.[0]?.base64) return null;
  return { base64: result.assets[0].base64 as string, uri: result.assets[0].uri };
}

function HRUploadPrompt({
  session, sessionLogId, userId, programId, dayName,
  session_type, prescribed_zone,
  onDebrief, onInvalid, onNetworkError, onSkip,
}: {
  session?: ProgramSession;
  sessionLogId: string | null;
  userId: string | null;
  programId?: string;
  dayName?: string;
  session_type?: string;
  prescribed_zone?: string;
  onDebrief: () => void;
  onInvalid: () => void;
  onNetworkError: () => void;
  onSkip: () => void;
}) {
  const [zoneChart, setZoneChart] = useState<PickedImage | null>(null);
  const [hrCurve, setHrCurve]     = useState<PickedImage | null>(null);
  const [loading, setLoading]     = useState(false);
  const [errorMsg, setErrorMsg]   = useState<string | null>(null);
  const [showCoachingNote, setShowCoachingNote] = useState(false);
  const [coachingNote, setCoachingNote]         = useState<string | null>(null);
  const [wearableSource, setWearableSource]     = useState('unknown');
  const spinVal = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!userId) return;
    supabase
      .from('profiles')
      .select('wearable')
      .eq('id', userId)
      .single()
      .then(({ data }) => { if (data?.wearable) setWearableSource(data.wearable); });
  }, [userId]);

  useEffect(() => {
    if (!loading) return;
    Animated.loop(
      Animated.timing(spinVal, { toValue: 1, duration: 900, useNativeDriver: true }),
    ).start();
    return () => { spinVal.stopAnimation(); spinVal.setValue(0); };
  }, [loading]);

  const spin = spinVal.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  async function analyze() {
    if (!sessionLogId) {
      setErrorMsg('Session must be saved before uploading HR data.');
      return;
    }
    setErrorMsg(null);
    setLoading(true);
    try {
      const body: Record<string, any> = {
        sessionLogId,
        userId,
        session_type:    session_type    ?? 'unknown',
        prescribed_zone: prescribed_zone ?? 'unknown',
        wearable_source: wearableSource,
      };
      if (zoneChart) body.zoneChartBase64 = zoneChart.base64.replace(/^data:image\/\w+;base64,/, '');
      if (hrCurve)   body.hrCurveBase64  = hrCurve.base64.replace(/^data:image\/\w+;base64,/, '');

      const res = await fetch('https://peak65.vercel.app/api/extract-hr-zones', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) { onNetworkError(); return; }

      const data = await res.json();
      if (!data.success || data.analysis?.image_valid === false) { onInvalid(); return; }

      const notes = data.hr_coaching_notes || data.analysis?.hr_coaching_notes || null;
      setCoachingNote(notes);
      setShowCoachingNote(true);
    } catch {
      onNetworkError();
    } finally {
      setLoading(false);
    }
  }

  const hasImage = !!(zoneChart || hrCurve);

  if (showCoachingNote) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: '#080808' }} edges={['bottom']}>
        <StatusBar barStyle="light-content" />
        <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 32, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
          <View style={{ alignItems: 'center', marginBottom: 20 }}>
            <Feather name="check-circle" size={40} color="#e8ff47" />
          </View>
          <View style={{ backgroundColor: '#111111', borderLeftWidth: 3, borderLeftColor: '#e8ff47', padding: 16, borderRadius: 4, marginBottom: 20 }}>
            <Text style={{ color: '#e8ff47', fontSize: 12, fontWeight: '700', letterSpacing: 3, fontFamily: 'BarlowCondensed_700Bold', marginBottom: 10 }}>
              COACHING FEEDBACK
            </Text>
            <Text style={{ color: '#f0ede8', fontSize: 15, lineHeight: 24 }}>
              {coachingNote || 'HR data saved. Your coach will review this with your next program.'}
            </Text>
          </View>
          <TouchableOpacity
            style={{ backgroundColor: '#e8ff47', borderRadius: 8, paddingVertical: 14, alignItems: 'center' }}
            onPress={onDebrief}
          >
            <Text style={{ color: '#080808', fontSize: 16, fontWeight: '700' }}>Done →</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#080808' }} edges={['bottom']}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} showsVerticalScrollIndicator={false}>

        {/* Top */}
        <View style={{ paddingHorizontal: 24, alignItems: 'center' }}>
          <Feather name="activity" size={36} color="#e8ff47" style={{ marginBottom: 8 }} />
          <Text style={{ fontSize: 24, fontWeight: '800', color: '#e8ff47', textAlign: 'center', fontFamily: 'BarlowCondensed_700Bold' }}>
            Upload your HR data.
          </Text>
          <Text style={{ fontSize: 15, color: '#8a877f', marginTop: 8, lineHeight: 22, textAlign: 'center' }}>
            Your coach reviews your heart rate after every session. One screenshot tells them more than any summary.
          </Text>
        </View>

        {/* Instruction card */}
        <View style={{ backgroundColor: '#111111', borderRadius: 12, marginTop: 16, marginHorizontal: 24, marginBottom: 24, padding: 20 }}>
          <Text style={{ color: '#e8ff47', fontSize: 13, fontWeight: '700', letterSpacing: 1, fontFamily: 'BarlowCondensed_700Bold' }}>
            WHAT TO UPLOAD
          </Text>
          {([
            { icon: 'smartphone' as const, text: 'Open Whoop, Garmin, Apple Health, or Polar' },
            { icon: 'bar-chart-2' as const, text: "Find today's session or activity" },
            { icon: 'camera' as const, text: 'Screenshot your zone chart, your HR graph, or both' },
          ] as const).map((row, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16 }}>
              <Feather name={row.icon} size={20} color="#e8ff47" />
              <Text style={{ color: '#f0ede8', fontSize: 15, flex: 1 }}>{row.text}</Text>
            </View>
          ))}
        </View>

        {/* Tip */}
        <View style={{ backgroundColor: '#1a1a1a', borderRadius: 8, marginHorizontal: 24, padding: 12, flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
          <Feather name="info" size={16} color="#8a877f" style={{ marginTop: 2 }} />
          <Text style={{ color: '#8a877f', fontSize: 13, lineHeight: 20, flex: 1 }}>
            Zone chart = time in each zone. HR graph = your heart rate over time. Both together gives us the full picture.
          </Text>
        </View>

        {/* Upload buttons or loading */}
        <View style={{ margin: 24, gap: 12 }}>
          {errorMsg && (
            <Text style={{ color: '#ff6b6b', fontSize: 14, textAlign: 'center' }}>{errorMsg}</Text>
          )}
          {loading ? (
            <View style={{ alignItems: 'center', paddingVertical: 24 }}>
              {/* Thumbnails */}
              {(zoneChart || hrCurve) && (
                <View style={{ flexDirection: 'row', gap: 12, marginBottom: 24 }}>
                  {zoneChart && (
                    <View>
                      <Image source={{ uri: zoneChart.uri }} style={{ width: 80, height: 80, borderRadius: 8 }} />
                      <View style={{ position: 'absolute', top: 4, right: 4, backgroundColor: '#00d4aa', borderRadius: 10, width: 20, height: 20, alignItems: 'center', justifyContent: 'center' }}>
                        <Feather name="check" size={12} color="#080808" />
                      </View>
                    </View>
                  )}
                  {hrCurve && (
                    <View>
                      <Image source={{ uri: hrCurve.uri }} style={{ width: 80, height: 80, borderRadius: 8 }} />
                      <View style={{ position: 'absolute', top: 4, right: 4, backgroundColor: '#00d4aa', borderRadius: 10, width: 20, height: 20, alignItems: 'center', justifyContent: 'center' }}>
                        <Feather name="check" size={12} color="#080808" />
                      </View>
                    </View>
                  )}
                </View>
              )}
              <Animated.View style={{ transform: [{ rotate: spin }] }}>
                <Feather name="refresh-cw" size={32} color="#e8ff47" />
              </Animated.View>
              <Text style={{ color: '#f0ede8', fontSize: 17, marginTop: 12 }}>Analyzing your session...</Text>
              <Text style={{ color: '#8a877f', fontSize: 14, marginTop: 4, textAlign: 'center' }}>
                Your coach is reviewing the data. This takes about 10 seconds.
              </Text>
            </View>
          ) : (
            <>
              {/* Zone Chart button */}
              <TouchableOpacity
                style={{ backgroundColor: '#111111', borderWidth: 1.5, borderColor: '#e8ff47', borderRadius: 12, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14 }}
                onPress={async () => { const img = await pickImage(); if (img) setZoneChart(img); }}
              >
                {zoneChart ? (
                  <Image source={{ uri: zoneChart.uri }} style={{ width: 40, height: 40, borderRadius: 6 }} />
                ) : (
                  <Feather name="upload" size={20} color="#e8ff47" />
                )}
                <View style={{ flex: 1 }}>
                  <Text style={{ color: '#f0ede8', fontSize: 18, fontWeight: '700', fontFamily: 'BarlowCondensed_700Bold' }}>
                    Zone Chart{zoneChart ? ' ✓' : ''}
                  </Text>
                  <Text style={{ color: '#8a877f', fontSize: 13 }}>Bar chart or pie chart showing zone breakdown</Text>
                </View>
                <Feather name="chevron-right" size={16} color="#8a877f" />
              </TouchableOpacity>

              {/* HR Graph button */}
              <TouchableOpacity
                style={{ backgroundColor: '#111111', borderWidth: 1.5, borderColor: '#e8ff47', borderRadius: 12, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14 }}
                onPress={async () => { const img = await pickImage(); if (img) setHrCurve(img); }}
              >
                {hrCurve ? (
                  <Image source={{ uri: hrCurve.uri }} style={{ width: 40, height: 40, borderRadius: 6 }} />
                ) : (
                  <Feather name="activity" size={20} color="#e8ff47" />
                )}
                <View style={{ flex: 1 }}>
                  <Text style={{ color: '#f0ede8', fontSize: 18, fontWeight: '700', fontFamily: 'BarlowCondensed_700Bold' }}>
                    HR Graph{hrCurve ? ' ✓' : ''}
                  </Text>
                  <Text style={{ color: '#8a877f', fontSize: 13 }}>Line graph showing heart rate over time</Text>
                </View>
                <Feather name="chevron-right" size={16} color="#8a877f" />
              </TouchableOpacity>

              {/* Analyze button */}
              {hasImage && (
                <TouchableOpacity
                  style={{ backgroundColor: '#e8ff47', borderRadius: 12, height: 56, alignItems: 'center', justifyContent: 'center', marginTop: 4 }}
                  onPress={analyze}
                >
                  <Text style={{ color: '#080808', fontSize: 18, fontWeight: '800', fontFamily: 'BarlowCondensed_700Bold' }}>
                    Analyze My Session
                  </Text>
                </TouchableOpacity>
              )}

              {/* Skip */}
              <TouchableOpacity style={{ alignItems: 'center', marginTop: 4 }} onPress={onSkip}>
                <Text style={{ color: '#8a877f', fontSize: 15, textDecorationLine: 'underline' }}>Skip for now</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

export default HRUploadPrompt;
