import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, FlatList, TextInput, TouchableOpacity,
  KeyboardAvoidingView, Platform, StyleSheet, ActivityIndicator, SafeAreaView, Keyboard,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Feather } from '@expo/vector-icons';
import { MessageSquare } from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import Tooltip from '../components/Tooltip';
import { supabase } from '../../lib/supabase';
import { Colors } from '../../lib/theme';
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
  if (d.toDateString() === today.toDateString()) return 'TODAY';
  if (d.toDateString() === yesterday.toDateString()) return 'YESTERDAY';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }).toUpperCase();
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

async function getAccessToken(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

export default function MessagesScreen() {
  const { setHasUnread } = React.useContext(UnreadContext);
  const [userId,    setUserId]    = useState<string | null>(null);
  const [coachName, setCoachName] = useState('');
  // Whether an active coach link exists. Previously inferred by comparing
  // coachName to a sentinel string — split out so the displayed name can change
  // without altering who gets an automated reply.
  const [hasCoach,  setHasCoach]  = useState(false);
  const [msgs,      setMsgs]      = useState<Msg[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [input,     setInput]     = useState('');
  const [sending,   setSending]   = useState(false);
  const listRef     = useRef<FlatList<ListItem>>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sendingRef  = useRef(false);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight]   = useState(0);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (e) => {
      setKeyboardHeight(e.endCoordinates.height);
      setKeyboardVisible(true);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardHeight(0);
      setKeyboardVisible(false);
    });
    return () => { show.remove(); hide.remove(); };
  }, []);

  function handleLongPress(msgId: string, body: string) {
    Clipboard.setStringAsync(body).catch(() => {});
    setCopiedMsgId(msgId);
    setTimeout(() => setCopiedMsgId(null), 500);
  }

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
      .eq('status', 'active')
      .maybeSingle();
    if (!ca?.coach_id) { setCoachName('Peak 65'); setHasCoach(false); return; }
    setHasCoach(true);
    const { data: p } = await supabase
      .from('profiles')
      .select('first_name, last_name')
      .eq('id', ca.coach_id)
      .maybeSingle();
    setCoachName(p ? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || 'Coach' : 'Coach');
  }

  async function fetchMessages(uid: string, initial = false) {
    try {
      const token = await getAccessToken();
      const res = await fetch(`${API_BASE}/api/coach/messages?athleteId=${uid}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        const json = await res.json();
        const list: Msg[] = Array.isArray(json) ? json : (json.messages ?? []);
        setMsgs(list);
      }
    } catch {}
    if (initial) setLoading(false);
    // mark incoming messages as read
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
        if (userId && !sendingRef.current) fetchMessages(userId, false);
      }, 10000);
      return () => {
        if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      };
    }, [userId])
  );

  async function handleSend() {
    const body = input.trim();
    if (!body || !userId || sending) return;
    console.log('[messages] handleSend fired, userId:', userId, 'body length:', body.length);
    const tempId = `temp-${Date.now()}`;
    const tempMsg: Msg = { id: tempId, sender_id: userId, body, created_at: new Date().toISOString(), read_at: null };
    setMsgs(prev => [...prev, tempMsg]);
    setInput('');
    setSending(true);
    sendingRef.current = true;
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    try {
      const token = await getAccessToken();
      console.log('[messages] about to fetch send-message, token present:', !!token);
      const res = await fetch(`${API_BASE}/api/coach/send-message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ athleteId: userId, body }),
      });
      console.log('[messages] send-message response status:', res.status, 'ok:', res.ok);
      if (!res.ok) throw new Error('send failed');
      if (!hasCoach) {
        fetch(`${API_BASE}/api/ai-reply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, messageBody: body }),
        }).catch(() => {});
      }
      await new Promise<void>(resolve => setTimeout(resolve, 2000));
      try {
        const token2 = await getAccessToken();
        const res2 = await fetch(`${API_BASE}/api/coach/messages?athleteId=${userId}`, {
          headers: token2 ? { Authorization: `Bearer ${token2}` } : {},
        });
        if (res2.ok) {
          const json2 = await res2.json();
          const freshList: Msg[] = Array.isArray(json2) ? json2 : (json2.messages ?? []);
          const found = freshList.some(m => m.body === body && m.sender_id === userId);
          if (found) setMsgs(freshList);
        }
      } catch {}
    } catch (err) {
      setMsgs(prev => prev.filter(m => m.id !== tempId));
      setInput(body);
    } finally {
      setSending(false);
      sendingRef.current = false;
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
              <MessageSquare color={Colors.textSecondary} size={36} strokeWidth={1.5} />
              <Text style={s.emptyText}>No messages yet</Text>
              <Text style={s.emptySubText}>Your coach will send you a message after your first session.</Text>
            </View>
          }
          renderItem={({ item, index }) => {
            if ('kind' in item) {
              return (
                <View style={s.dateSep}>
                  <Text style={s.dateText}>{item.label}</Text>
                </View>
              );
            }
            const mine = userId != null && item.sender_id.toString().trim() === userId.toString().trim();
            const copied = copiedMsgId === item.id;
            const prevItem = index > 0 ? items[index - 1] : null;
            const prevMsg = prevItem && !('kind' in prevItem) ? prevItem as Msg : null;
            const isLast = index === items.length - 1;
            const showTime = isLast || !prevMsg ||
              (new Date(item.created_at).getTime() - new Date(prevMsg.created_at).getTime()) > 5 * 60 * 1000;
            return (
              <View style={[s.bubbleRow, mine ? s.bubbleRowRight : s.bubbleRowLeft]}>
                <TouchableOpacity
                  onLongPress={() => handleLongPress(item.id, item.body)}
                  delayLongPress={300}
                  activeOpacity={0.85}
                  style={[s.bubble, mine ? s.bubbleMine : s.bubbleTheirs, copied && s.bubbleCopied]}
                >
                  <Text style={[s.bubbleText, mine ? s.bubbleTextMine : s.bubbleTextTheirs]}>
                    {item.body}
                  </Text>
                </TouchableOpacity>
                {showTime && (
                  <Text style={[s.timeText, mine ? s.timeRight : s.timeLeft]}>
                    {formatTime(item.created_at)}
                  </Text>
                )}
              </View>
            );
          }}
        />
        <Tooltip id="messages_coach" text="Ask your coach anything about your program, your progress, or what is coming up." arrowDirection="down">
        <View style={s.compose}>
          <TextInput
            style={s.textInput}
            value={input}
            onChangeText={setInput}
            placeholder="Message your coach..."
            placeholderTextColor={Colors.textSecondary}
            multiline
          />
          <TouchableOpacity
            style={[s.sendBtn, (!input.trim() || sending) && s.sendBtnDisabled]}
            onPress={handleSend}
            disabled={!input.trim() || sending}
          >
            <Feather name="send" size={18} color="#080808" />
          </TouchableOpacity>
        </View>
        </Tooltip>
        {keyboardVisible && (
          <TouchableOpacity
            onPress={() => Keyboard.dismiss()}
            style={{ position: 'absolute', bottom: keyboardHeight + 8, right: 16, width: 36, height: 36, borderRadius: 18, backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center' }}
          >
            <Feather name="chevron-down" size={20} color="#8a877f" />
          </TouchableOpacity>
        )}
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
  dateText:          { color: Colors.textSecondary, fontSize: 10, fontWeight: '700', letterSpacing: 2 },
  bubbleRow:         { marginBottom: 8 },
  bubbleRowRight:    { alignItems: 'flex-end' },
  bubbleRowLeft:     { alignItems: 'flex-start' },
  bubble:            { maxWidth: '75%', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10 },
  bubbleMine:        { backgroundColor: Colors.accent, borderBottomRightRadius: 4 },
  bubbleTheirs:      { backgroundColor: Colors.nested, borderBottomLeftRadius: 4 },
  bubbleCopied:      { opacity: 0.5 },
  bubbleText:        { fontSize: 13, lineHeight: 18 },
  bubbleTextMine:    { color: '#080808' },
  bubbleTextTheirs:  { color: Colors.textPrimary },
  timeText:          { color: Colors.textSecondary, fontSize: 10, marginTop: 3, marginHorizontal: 2 },
  timeRight:         {},
  timeLeft:          {},
  empty:             { alignItems: 'center', paddingTop: 80, gap: 8 },
  emptyText:         { color: Colors.textSecondary, fontSize: 14, marginTop: 4 },
  emptySubText:      { color: Colors.textSecondary, fontSize: 12 },
  compose:           { flexDirection: 'row', alignItems: 'flex-end', padding: 12, gap: 10, borderTopWidth: 1, borderTopColor: Colors.border },
  textInput:         { flex: 1, backgroundColor: Colors.nested, color: Colors.textPrimary, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', paddingHorizontal: 16, paddingVertical: 10, fontSize: 13, maxHeight: 120 },
  sendBtn:           { width: 38, height: 38, borderRadius: 19, backgroundColor: Colors.accent, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled:   { opacity: 0.35 },
});
