import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '../../lib/supabase';

const YELLOW    = '#e8ff47';
const BLACK     = '#080808';
const OFF_WHITE = '#f0ede8';
const GREY      = '#8a877f';
const CARD_BG   = '#111111';

// ─── Types ────────────────────────────────────────────────────────────────────

type Profile = {
  id: string;
  first_name: string;
  last_name: string;
  email?: string;
  goal: string;
  hyrox_division: string | null;
  rest_days: number | null;
  session_length: string | null;
  availability: string | null;
  equipment_access: string[] | null;
  body_weight: number | null;
  weight_unit: string | null;
  body_fat_range: string | null;
};

// ─── Picker modal ─────────────────────────────────────────────────────────────

function PickerModal({
  title, options, value, onSelect, onClose,
}: {
  title: string;
  options: { label: string; value: string }[];
  value: string | null;
  onSelect: (v: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal transparent animationType="slide" visible>
      <View style={styles.pickerBackdrop}>
        <View style={styles.pickerSheet}>
          <Text style={styles.pickerTitle}>{title}</Text>
          {options.map(opt => (
            <TouchableOpacity key={opt.value}
              style={[styles.pickerOption, value === opt.value && styles.pickerOptionActive]}
              onPress={() => { onSelect(opt.value); onClose(); }}>
              <Text style={[styles.pickerOptionText, value === opt.value && { color: BLACK }]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity onPress={onClose} style={{ marginTop: 8 }}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ─── Multi-select modal ───────────────────────────────────────────────────────

function MultiSelectModal({
  title, options, values, onSave, onClose,
}: {
  title: string;
  options: string[];
  values: string[];
  onSave: (vs: string[]) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(values);
  function toggle(v: string) {
    setSelected(s => s.includes(v) ? s.filter(x => x !== v) : [...s, v]);
  }
  return (
    <Modal transparent animationType="slide" visible>
      <View style={styles.pickerBackdrop}>
        <View style={[styles.pickerSheet, { maxHeight: '75%' }]}>
          <Text style={styles.pickerTitle}>{title}</Text>
          <ScrollView showsVerticalScrollIndicator={false}>
            {options.map(opt => (
              <TouchableOpacity key={opt}
                style={[styles.pickerOption, selected.includes(opt) && styles.pickerOptionActive]}
                onPress={() => toggle(opt)}>
                <Text style={[styles.pickerOptionText, selected.includes(opt) && { color: BLACK }]}>
                  {opt}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <TouchableOpacity style={styles.saveBtn}
            onPress={() => { onSave(selected); onClose(); }}>
            <Text style={styles.saveBtnText}>SAVE</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onClose} style={{ marginTop: 8 }}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ─── Row components ───────────────────────────────────────────────────────────

function SettingRow({
  label, value, onPress,
}: {
  label: string; value: string; onPress?: () => void;
}) {
  return (
    <TouchableOpacity style={styles.settingRow} onPress={onPress} disabled={!onPress}>
      <Text style={styles.settingLabel}>{label}</Text>
      <View style={styles.settingRight}>
        <Text style={styles.settingValue} numberOfLines={1}>{value || '—'}</Text>
        {!!onPress && <Text style={styles.settingChevron}>›</Text>}
      </View>
    </TouchableOpacity>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ProfileScreen() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [email, setEmail]     = useState('');
  const [loading, setLoading] = useState(true);
  const [picker, setPicker]   = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) { setLoading(false); return; }
    setEmail(authData.user.email ?? '');

    const { data } = await supabase.from('profiles').select('*').eq('id', authData.user.id).single();
    setProfile(data);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function updateProfile(patch: Partial<Profile>) {
    if (!profile) return;
    const updated = { ...profile, ...patch };
    setProfile(updated);
    await supabase.from('profiles').update(patch).eq('id', profile.id);
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <ActivityIndicator color={YELLOW} style={{ flex: 1 }} />
      </SafeAreaView>
    );
  }

  const goalBadge = profile?.goal === 'hyrox'
    ? `Hyrox${profile.hyrox_division ? ` • ${profile.hyrox_division}` : ''}`
    : profile?.goal === 'general_fitness' ? 'General Fitness' : '';

  const GOAL_OPTIONS = [
    { label: 'Train for Hyrox', value: 'hyrox' },
    { label: 'General Fitness', value: 'general_fitness' },
  ];
  const DIVISION_OPTIONS = [
    { label: 'Men Open', value: 'Men Open' },
    { label: 'Men Pro', value: 'Men Pro' },
    { label: 'Women Open', value: 'Women Open' },
    { label: 'Women Pro', value: 'Women Pro' },
    { label: 'Mixed Doubles', value: 'Mixed Doubles' },
  ];
  const REST_OPTIONS = [
    { label: '1 day', value: '1' },
    { label: '2 days', value: '2' },
    { label: '3 days', value: '3' },
  ];
  const LENGTH_OPTIONS = [
    { label: 'About 1 hour', value: '60' },
    { label: 'About 1.5–2 hours', value: '90' },
  ];
  const AVAIL_OPTIONS = [
    { label: 'Once a day', value: 'once' },
    { label: 'Twice a day (AM + PM)', value: 'twice' },
  ];
  const EQUIPMENT_OPTIONS = profile?.goal === 'hyrox'
    ? ['Barbell + Rack', 'Dumbbells', 'Kettlebells', 'Pull-up Bar', 'Ski Erg', 'Row Erg', 'Sled', 'Assault Bike', 'Full Gym Access']
    : ['Barbell + Rack', 'Dumbbells', 'Kettlebells', 'Pull-up Bar', 'Ski Erg', 'Row Erg', 'Assault Bike', 'Full Gym Access', 'No Equipment'];
  const BF_OPTIONS = [
    { label: 'Under 10%', value: 'Under 10%' },
    { label: '10–15%', value: '10-15%' },
    { label: '15–20%', value: '15-20%' },
    { label: '20–25%', value: '20-25%' },
    { label: '25–30%', value: '25-30%' },
    { label: '30%+', value: '30%+' },
    { label: "Unsure", value: 'unsure' },
  ];

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Pickers */}
      {picker === 'goal' && (
        <PickerModal title="Goal" options={GOAL_OPTIONS} value={profile?.goal ?? null}
          onSelect={v => updateProfile({ goal: v })} onClose={() => setPicker(null)} />
      )}
      {picker === 'division' && (
        <PickerModal title="Division" options={DIVISION_OPTIONS} value={profile?.hyrox_division ?? null}
          onSelect={v => updateProfile({ hyrox_division: v })} onClose={() => setPicker(null)} />
      )}
      {picker === 'rest' && (
        <PickerModal title="Rest Days" options={REST_OPTIONS} value={String(profile?.rest_days ?? '')}
          onSelect={v => updateProfile({ rest_days: parseInt(v, 10) })} onClose={() => setPicker(null)} />
      )}
      {picker === 'length' && (
        <PickerModal title="Session Length" options={LENGTH_OPTIONS} value={profile?.session_length ?? null}
          onSelect={v => updateProfile({ session_length: v })} onClose={() => setPicker(null)} />
      )}
      {picker === 'availability' && (
        <PickerModal title="Availability" options={AVAIL_OPTIONS} value={profile?.availability ?? null}
          onSelect={v => updateProfile({ availability: v })} onClose={() => setPicker(null)} />
      )}
      {picker === 'bf' && (
        <PickerModal title="Body Fat Range" options={BF_OPTIONS} value={profile?.body_fat_range ?? null}
          onSelect={v => updateProfile({ body_fat_range: v })} onClose={() => setPicker(null)} />
      )}
      {picker === 'equipment' && (
        <MultiSelectModal
          title="Equipment Access"
          options={EQUIPMENT_OPTIONS}
          values={profile?.equipment_access ?? []}
          onSave={vs => updateProfile({ equipment_access: vs })}
          onClose={() => setPicker(null)}
        />
      )}

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 60 }}>
        {/* Name + badge */}
        <View style={styles.nameBlock}>
          <Text style={styles.name}>
            {profile?.first_name ?? ''} {profile?.last_name ?? ''}
          </Text>
          {!!goalBadge && <Text style={styles.goalBadge}>{goalBadge}</Text>}
        </View>

        {/* Training section */}
        <Text style={styles.sectionHeading}>Training</Text>
        <View style={styles.section}>
          <SettingRow label="Goal" value={GOAL_OPTIONS.find(o => o.value === profile?.goal)?.label ?? ''} onPress={() => setPicker('goal')} />
          {profile?.goal === 'hyrox' && (
            <SettingRow label="Division" value={profile?.hyrox_division ?? ''} onPress={() => setPicker('division')} />
          )}
          <SettingRow label="Rest Days" value={profile?.rest_days != null ? `${profile.rest_days} day${profile.rest_days !== 1 ? 's' : ''}` : ''} onPress={() => setPicker('rest')} />
          <SettingRow label="Session Length" value={profile?.session_length === '60' ? '~1 hour' : profile?.session_length === '90' ? '~1.5–2 hours' : profile?.session_length ?? ''} onPress={() => setPicker('length')} />
          <SettingRow label="Availability" value={profile?.availability === 'once' ? 'Once a day' : profile?.availability === 'twice' ? 'Twice a day' : profile?.availability ?? ''} onPress={() => setPicker('availability')} />
          <SettingRow label="Equipment" value={(profile?.equipment_access ?? []).join(', ')} onPress={() => setPicker('equipment')} />
        </View>

        {/* Wearables section */}
        <Text style={styles.sectionHeading}>Wearables</Text>
        <View style={styles.section}>
          <SettingRow label="Apple Health" value="Connect" />
          <SettingRow label="Garmin" value="Connect" />
        </View>

        {/* Body section */}
        <Text style={styles.sectionHeading}>Body</Text>
        <View style={styles.section}>
          <SettingRow
            label="Body Fat Range"
            value={BF_OPTIONS.find(o => o.value === profile?.body_fat_range)?.label ?? profile?.body_fat_range ?? ''}
            onPress={() => setPicker('bf')}
          />
        </View>

        {/* Account section */}
        <Text style={styles.sectionHeading}>Account</Text>
        <View style={styles.section}>
          <SettingRow label="Email" value={email} />
          <SettingRow label="Subscription" value="AI Coached • Active" />
        </View>

        {/* Sign out */}
        <TouchableOpacity style={styles.signOutBtn} onPress={handleSignOut}>
          <Text style={styles.signOutText}>SIGN OUT</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BLACK },

  nameBlock: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 16 },
  name: { color: OFF_WHITE, fontSize: 24, fontWeight: '800' },
  goalBadge: { color: GREY, fontSize: 14, marginTop: 4 },

  sectionHeading: {
    color: GREY, fontSize: 11, fontWeight: '700', letterSpacing: 1.5,
    textTransform: 'uppercase', paddingHorizontal: 20, marginTop: 20, marginBottom: 8,
  },
  section: {
    marginHorizontal: 16, backgroundColor: CARD_BG, borderRadius: 14, overflow: 'hidden',
  },
  settingRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 15,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#222',
  },
  settingLabel: { color: OFF_WHITE, fontSize: 15 },
  settingRight: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '55%' },
  settingValue: { color: GREY, fontSize: 14, textAlign: 'right', flexShrink: 1 },
  settingChevron: { color: GREY, fontSize: 18 },

  signOutBtn: {
    marginHorizontal: 16, marginTop: 24, backgroundColor: '#1a0000',
    borderRadius: 12, paddingVertical: 16, alignItems: 'center',
  },
  signOutText: { color: '#ff4444', fontSize: 16, fontWeight: '700' },

  // Picker
  pickerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  pickerSheet: {
    backgroundColor: CARD_BG, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, paddingBottom: 40,
  },
  pickerTitle: { color: OFF_WHITE, fontSize: 16, fontWeight: '700', marginBottom: 14, textAlign: 'center' },
  pickerOption: {
    paddingVertical: 14, paddingHorizontal: 16, backgroundColor: '#1a1a1a',
    borderRadius: 10, marginBottom: 8,
  },
  pickerOptionActive: { backgroundColor: YELLOW },
  pickerOptionText: { color: OFF_WHITE, fontSize: 15 },
  cancelText: { color: GREY, fontSize: 15, textAlign: 'center' },
  saveBtn: {
    backgroundColor: YELLOW, borderRadius: 10, paddingVertical: 14,
    alignItems: 'center', marginTop: 12,
  },
  saveBtnText: { color: BLACK, fontSize: 15, fontWeight: '700' },
});
