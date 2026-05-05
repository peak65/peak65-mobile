import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, FlatList, TextInput, TouchableOpacity,
  KeyboardAvoidingView, Platform, StyleSheet, ActivityIndicator, SafeAreaView,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Feather } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { Colors, Fonts } from '../../lib/theme';
import { UnreadContext } from '../_layout';

const API_BASE = 'https://peak65.vercel.app';

type Msg = {
  id: string;
  sender_id: string;
  body: string;
  created_at: string;
  read_at: string | null;
};

type DateSep = { kind: 'date'; label: string; key: string };
type ListItem = Msg | DateSep;

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function buildItems(msgs: Msg[]): ListItem[] {
  const items: ListItem[] = [];
  let lastDate = '';
  for (const m of msgs) {
    const dateStr = new Date(m.created_at).toDateString();
    if (dateStr !== lastDate) {
      items.push({ kind: 'date', label: formatDate(m.created_at), key: `date-${dateStr}` });
      lastDate = dateStr;
    }
    items.push(m);
  }
  return items;
}

export default function MessagesScreen() {
  const { setHasUnread } = React.useContext(UnreadContext);
  const [userId,    setUserId]    = useState<string | null>(null);
  const [coachName, setCoachName] = useState('');
  const [msgs,      setMsgs]      = useState<Msg[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [input,     setInput]     = useState('');
  const [sending,   setSending]   = useState(false);
  const listRef     = useRef<FlatList<ListItem>>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user?.id) setUserId(session.user.id);
    });
  }, []);

  useEffect(() => {
    if (!userId) return;
    loadCoach(userId);
    fetchMessages(userId, true);
  }, [userId]);

  async function loadCoach(uid: string) {
    const { data: ca } = await supabase
      .from('coach_athletes')
      .select('coach_id')
      .eq('athlete_id', uid)
      .maybeSingle();
    if (!ca?.coach_id) { setCoachName('Peak 65 AI'); return; }
    const { data: p } = await supabase
      .from('profiles')
      .select('first_name, last_name')
      .eq('id', ca.coach_id)
      .maybeSingle();
    setCoachName(p ? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || 'Coach' : 'Coach');
  }

  async function fetchMessages(uid: string, initial = false) {
    try {
      const res = await fetch(`${API_BASE}/api/coach/messages?athleteId=${uid}`);
      if (res.ok) {
        const json = await res.json();
        const list: Msg[] = Array.isArray(json) ? json : (json.messages ?? []);
        setMsgs(list);
      }
    } catch {}
    if (initial) setLoading(false);
    // mark coach messages as read
    try {
      await supabase
        .from('messages')
        .update({ read_at: new Date().toISOString() })
        .eq('athlete_id', uid)
        .is('read_at', null)
        .neq('sender_id', uid);
      setHasUnread(false);
    } catch {}
  }

  useFocusEffect(
    useCallback(() => {
      if (userId) {
        fetchMessages(userId, false);
        setHasUnread(false);
      }
      intervalRef.current = setInterval(() => {
        if (userId) fetchMessages(userId, false);
      }, 10000);
      return () => {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      };
    }, [userId])
  );

  async function handleSend() {
    const body = input.trim();
    if (!body || !userId || sending) return;
    const tempId = `temp-${Date.now()}`;
    const tempMsg: Msg = { id: tempId, sender_id: userId, body, created_at: new Date().toISOString(), read_at: null };
    setMsgs(prev => [...prev, tempMsg]);
    setInput('');
    setSending(true);
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    try {
      const res = await fetch(`${API_BASE}/api/coach/send-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ athleteId: userId, senderId: userId, body }),
      });
      if (!res.ok) throw new Error('send failed');
      await fetchMessages(userId, false);
    } catch {
      setMsgs(prev => prev.filter(m => m.id !== tempId));
      setInput(body);
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <View style={s.loadingContainer}>
        <ActivityIndicator color={Colors.accent} />
      </View>
    );
  }

  const items = buildItems(msgs);

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Text style={s.headerTitle}>{coachName || 'Messages'}</Text>
      </View>
      <KeyboardAvoidingView
        style={s.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        <FlatList
          ref={listRef}
          data={items}
          keyExtractor={item => ('key' in item ? item.key : item.id)}
          contentContainerStyle={s.listContent}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          ListEmptyComponent={
            <View style={s.empty}>
              <Text style={s.emptyText}>No messages yet.</Text>
              <Text style={s.emptySubText}>Start a conversation with your coach.</Text>
            </View>
          }
          renderItem={({ item }) => {
            if ('kind' in item) {
              return <View style={s.dateSep}><Text style={s.dateText}>{item.label}</Text></View>;
            }
            const mine = item.sender_id === userId;
            return (
              <View style={[s.bubbleRow, mine ? s.bubbleRowRight : s.bubbleRowLeft]}>
                <View style={[s.bubble, mine ? s.bubbleMine : s.bubbleTheirs]}>
                  <Text style={[s.bubbleText, mine ? s.bubbleTextMine : s.bubbleTextTheirs]}>
                    {item.body}
                  </Text>
                </View>
                <Text style={[s.timeText, mine ? s.timeRight : s.timeLeft]}>
                  {formatTime(item.created_at)}
                </Text>
              </View>
            );
          }}
        />
        <View style={s.compose}>
          <TextInput
            style={s.textInput}
            value={input}
            onChangeText={setInput}
            placeholder="Message your coach..."
            placeholderTextColor={Colors.textSecondary}
            multiline
            returnKeyType="default"
          />
          <TouchableOpacity
            style={s.sendBtn}
            onPress={handleSend}
            disabled={!input.trim() || sending}
          >
            <Feather
              name="send"
              size={20}
              color={!input.trim() || sending ? Colors.textSecondary : Colors.accent}
            />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:              { flex: 1, backgroundColor: Colors.background },
  flex:              { flex: 1 },
  loadingContainer:  { flex: 1, backgroundColor: Colors.background, alignItems: 'center', justifyContent: 'center' },
  header:            { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: Colors.border },
  headerTitle:       { color: Colors.textPrimary, fontSize: 17, fontWeight: '600' },
  listContent:       { padding: 16 },
  dateSep:           { alignItems: 'center', marginVertical: 12 },
  dateText:          { color: Colors.textSecondary, fontSize: 12 },
  bubbleRow:         { marginBottom: 6 },
  bubbleRowRight:    { alignItems: 'flex-end' },
  bubbleRowLeft:     { alignItems: 'flex-start' },
  bubble:            { maxWidth: '75%', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10 },
  bubbleMine:        { backgroundColor: Colors.accent, borderBottomRightRadius: 4 },
  bubbleTheirs:      { backgroundColor: Colors.nested, borderBottomLeftRadius: 4 },
  bubbleText:        { fontSize: 15, lineHeight: 20 },
  bubbleTextMine:    { color: '#080808' },
  bubbleTextTheirs:  { color: Colors.textPrimary },
  timeText:          { color: Colors.textSecondary, fontSize: 11, marginTop: 2, marginHorizontal: 4 },
  timeRight:         {},
  timeLeft:          {},
  empty:             { alignItems: 'center', paddingTop: 80 },
  emptyText:         { color: Colors.textPrimary, fontSize: 16, marginBottom: 4 },
  emptySubText:      { color: Colors.textSecondary, fontSize: 13 },
  compose:           { flexDirection: 'row', alignItems: 'flex-end', padding: 12, gap: 8, borderTopWidth: 1, borderTopColor: Colors.border },
  textInput:         { flex: 1, backgroundColor: Colors.nested, color: Colors.textPrimary, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, maxHeight: 120 },
  sendBtn:           { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
});
