import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, Pressable, StyleSheet, ScrollView,
  Platform, Alert, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Check } from 'lucide-react-native';
import { supabase } from '../lib/supabase';
import { clearUserCache } from '../lib/userCache';
import { LEGAL_VERSION, LEGAL_URLS, LEGAL_DOCUMENTS } from '../lib/legal';
import type { MainStackParamList } from './_layout';
import { Colors } from '../lib/theme';
import { Logo } from '../components/Logo';

// Mandatory gate in front of the app for every signed-in account. There is no
// back button and gestures are disabled on the route — the only ways out are
// accepting (which writes an audit record first) or signing out.

type Props = NativeStackScreenProps<MainStackParamList, 'LegalAccept'>;

function destinationFor(next: string): 'Tabs' | 'Generating' | 'PinnacleSetup' | 'Onboarding' {
  switch (next) {
    case 'authenticated': return 'Tabs';
    case 'generating':    return 'Generating';
    case 'setup':         return 'PinnacleSetup';
    case 'onboarding':    return 'Onboarding';
    default:              return 'Tabs';
  }
}

function openDoc(url: string) {
  Linking.openURL(url).catch(e => {
    console.log('[legal-accept] openURL error:', e);
    Alert.alert('Error', 'Could not open the document.');
  });
}

function Checkbox({ checked, onPress, label, disabled }: {
  checked: boolean; onPress: () => void; label: string; disabled?: boolean;
}) {
  return (
    <Pressable
      style={styles.checkRow}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      hitSlop={{ top: 6, bottom: 6 }}
    >
      <View style={[styles.checkBox, checked && styles.checkBoxChecked]}>
        {checked && <Check color={Colors.background} size={16} strokeWidth={3} />}
      </View>
      <Text style={styles.checkLabel}>{label}</Text>
    </Pressable>
  );
}

export default function LegalAcceptScreen({ navigation, route }: Props) {
  const { next, fullName } = route.params;
  const [waiverChecked, setWaiverChecked] = useState(false);
  const [termsChecked,  setTermsChecked]  = useState(false);
  const [saving,        setSaving]        = useState(false);

  const canContinue = waiverChecked && termsChecked && !saving;

  async function handleContinue() {
    if (!canContinue) return;
    setSaving(true);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      Alert.alert('Session expired', 'Your session has expired. Please sign in again.');
      setSaving(false);
      return;
    }

    // 1. The acceptance record — written before anything else, and nothing
    // proceeds without it.
    const { error: insertError } = await supabase
      .from('legal_acceptances')
      .insert({
        user_id:   user.id,
        email:     user.email,
        full_name: fullName,
        version:   LEGAL_VERSION,
        documents: LEGAL_DOCUMENTS,
        platform:  Platform.OS,
      });

    if (insertError) {
      console.error('[legal-accept] acceptance insert failed:', insertError.message);
      Alert.alert('Something went wrong', 'We could not save your acceptance. Please try again.');
      setSaving(false);
      return;
    }

    // 2. Profile marker. If this fails the athlete sees the gate again next
    // launch and a second record is written — a duplicate beats a missing one.
    const { error: profileError } = await supabase
      .from('profiles')
      .update({
        legal_accepted_version: LEGAL_VERSION,
        legal_accepted_at:      new Date().toISOString(),
      })
      .eq('id', user.id);

    if (profileError) {
      console.error('[legal-accept] profile update failed:', profileError.message);
      Alert.alert('Something went wrong', 'We could not save your acceptance. Please try again.');
      setSaving(false);
      return;
    }

    navigation.replace(destinationFor(next));
  }

  async function handleSignOut() {
    // Same sequence as Profile — the auth listener in _layout.tsx routes to Login.
    await clearUserCache();
    await supabase.auth.signOut();
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <Logo width={150} />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.label}>Before you train</Text>
        <Text style={styles.sublabel}>
          Two things need your agreement before you can use Peak 65.
        </Text>

        <Text style={[styles.sectionHeader, { marginTop: 28 }]}>THE RISK</Text>
        <View style={styles.card}>
          <Text style={styles.body}>
            Training carries a real risk of serious injury and death — including muscle
            and tendon tears, fractures, heat illness, rhabdomyolysis, cardiac events,
            permanent disability and death.
          </Text>
          <Text style={styles.body}>
            Coaching here is remote. We cannot see you train, watch your form, or check
            your equipment. You decide, in the moment, whether to perform, modify or
            stop any session.
          </Text>
          <Text style={styles.body}>
            By accepting, you confirm you are 18 or older and medically able to train,
            and you release Peak 65 LLC from claims arising from ordinary negligence.
            This does not release gross negligence or intentional misconduct.
          </Text>
          <TouchableOpacity onPress={() => openDoc(LEGAL_URLS.waiver)} hitSlop={{ top: 8, bottom: 8 }}>
            <Text style={styles.link}>Read the full waiver</Text>
          </TouchableOpacity>
        </View>

        <Checkbox
          checked={waiverChecked}
          onPress={() => setWaiverChecked(v => !v)}
          disabled={saving}
          label="I have read and accept the Assumption of Risk and Waiver of Liability."
        />

        <Text style={[styles.sectionHeader, { marginTop: 28 }]}>TERMS AND PRIVACY</Text>
        <View style={styles.card}>
          {([
            ['Terms of Service',             LEGAL_URLS.terms],
            ['Privacy Policy',               LEGAL_URLS.privacy],
            ['Consumer Health Data Privacy', LEGAL_URLS.consumerHealth],
            ['Medical Disclaimer',           LEGAL_URLS.medicalDisclaimer],
          ] as const).map(([title, url]) => (
            <TouchableOpacity key={url} onPress={() => openDoc(url)} hitSlop={{ top: 6, bottom: 6 }}>
              <Text style={styles.link}>{title}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Checkbox
          checked={termsChecked}
          onPress={() => setTermsChecked(v => !v)}
          disabled={saving}
          label="I accept the Terms of Service and the Privacy Policy."
        />
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.continueBtn, !canContinue && styles.continueBtnDisabled]}
          onPress={handleContinue}
          disabled={!canContinue}
        >
          <Text style={styles.continueBtnText}>{saving ? 'SAVING…' : 'CONTINUE'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={handleSignOut}
          disabled={saving}
          style={{ alignItems: 'center', paddingVertical: 8 }}
        >
          <Text style={styles.signOutText}>Not ready? Sign out</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

// ─── Styles (mirrors onboarding/pinnacle-setup.tsx) ───────────────────────────

const styles = StyleSheet.create({
  container:     { flex:1, backgroundColor: Colors.background },
  scrollContent: { paddingHorizontal:24, paddingTop:20, paddingBottom:32 },

  label:         { color: Colors.textPrimary, fontSize: 26, fontWeight:'700', lineHeight:34, marginBottom:4 },
  sublabel:      { color: Colors.textSecondary, fontSize:14, lineHeight:20 },
  sectionHeader: { color: Colors.textSecondary, fontSize:11, fontWeight:'600', letterSpacing:2, marginBottom:8 },

  card:          { backgroundColor: Colors.card, borderWidth:1, borderColor: Colors.border, borderRadius:14, padding:16, gap:14 },
  body:          { color: Colors.textPrimary, fontSize:15, lineHeight:22 },
  link:          { color: Colors.accent, fontSize:15, fontWeight:'600' },

  checkRow:        { flexDirection:'row', alignItems:'flex-start', gap:12, marginTop:16 },
  checkBox:        { width:24, height:24, borderRadius:6, borderWidth:1.5, borderColor: Colors.textSecondary, alignItems:'center', justifyContent:'center', marginTop:1 },
  checkBoxChecked: { backgroundColor: Colors.accent, borderColor: Colors.accent },
  checkLabel:      { flex:1, color: Colors.textPrimary, fontSize:15, lineHeight:22 },

  footer:              { paddingHorizontal:24, paddingTop:8, paddingBottom:16, gap:8 },
  continueBtn:         { backgroundColor: Colors.accent, borderRadius:10, paddingVertical:16, alignItems:'center' },
  continueBtnDisabled: { opacity:0.4 },
  continueBtnText:     { color: Colors.background, fontSize:16, fontWeight:'700' },
  signOutText:         { color: Colors.textSecondary, fontSize:13 },
});
