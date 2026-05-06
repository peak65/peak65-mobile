import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';

import { supabase } from '../../lib/supabase';
import type { TabParamList } from '../_layout';
import { Colors, Fonts, scoreColor } from '../../lib/theme';

type Props = BottomTabScreenProps<TabParamList, 'Coach'>;

type AthleteEntry = {
  coachAthleteId: string;
  athleteId: string;
  tier: string;
  firstName: string;
  lastName: string;
  lastSession: { name: string; completedAt: string } | null;
  score: number | null;
  unreadCount: number;
};

const TIER_LABELS: Record<string, string> = {
  elite:      'Elite',
  coached:    'Coached',
  ai_coached: 'AI Coached',
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function CoachScreen({ navigation }: Props) {
  const [athletes, setAthletes]     = useState<AthleteEntry[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!mounted.current) return;
    if (!session?.user) return;
    const user = session.user;

    const { data: rows, error } = await supabase
      .from('coach_athletes')
      .select('id, athlete_id, tier, profile:profiles!athlete_id(first_name, last_name)')
      .eq('coach_id', user.id);

    console.log('[coach] raw rows:', JSON.stringify(rows?.slice(0, 3)), '| error:', error?.message);

    if (!mounted.current) return;
    if (error || !rows || rows.length === 0) {
      setAthletes([]);
      return;
    }

    const ids = rows.map(r => r.athlete_id as string);

    // Parallel: last sessions, unread messages, latest scores
    const [sessionRes, msgRes, scoreRes] = await Promise.all([
      supabase
        .from('session_logs')
        .select('user_id, session_name, completed_at')
        .in('user_id', ids)
        .eq('completed', true)
        .order('completed_at', { ascending: false }),
      supabase
        .from('messages')
        .select('athlete_id')
        .eq('coach_id', user.id)
        .in('athlete_id', ids)
        .is('read_at', null)
        .neq('sender_id', user.id),
      supabase
        .from('sixty_five_scores')
        .select('user_id, score')
        .in('user_id', ids)
        .order('date', { ascending: false }),
    ]);

    if (!mounted.current) return;
    // Build lookup maps
    const lastSessionMap = new Map<string, { name: string; completedAt: string }>();
    for (const s of sessionRes.data ?? []) {
      if (!lastSessionMap.has(s.user_id)) {
        lastSessionMap.set(s.user_id, { name: s.session_name, completedAt: s.completed_at });
      }
    }

    const unreadMap = new Map<string, number>();
    for (const m of msgRes.data ?? []) {
      unreadMap.set(m.athlete_id, (unreadMap.get(m.athlete_id) ?? 0) + 1);
    }

    const scoreMap = new Map<string, number>();
    for (const s of scoreRes.data ?? []) {
      if (!scoreMap.has(s.user_id)) scoreMap.set(s.user_id, s.score);
    }

    setAthletes(rows.map(r => {
      const p = (r as any).profile;
      return {
        coachAthleteId: r.id,
        athleteId:      r.athlete_id,
        tier:           r.tier,
        firstName:      p?.first_name ?? '',
        lastName:       p?.last_name  ?? '',
        lastSession:    lastSessionMap.get(r.athlete_id) ?? null,
        score:          scoreMap.get(r.athlete_id) ?? null,
        unreadCount:    unreadMap.get(r.athlete_id) ?? 0,
      };
    }));
  }, []);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  function openAthlete(athleteId: string) {
    (navigation as any).navigate('CoachAthleteDetail', { athleteId });
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Text style={styles.heading}>Athletes</Text>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />
        }
        showsVerticalScrollIndicator={false}
      >
        {loading ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : athletes.length === 0 ? (
          <Text style={styles.empty}>No athletes yet.</Text>
        ) : (
          athletes.map(a => (
            <TouchableOpacity
              key={a.athleteId}
              style={styles.card}
              onPress={() => openAthlete(a.athleteId)}
              activeOpacity={0.7}
            >
              {/* Row 1: name + unread dot + tier badge */}
              <View style={styles.cardTop}>
                <View style={styles.nameRow}>
                  <Text style={styles.name}>{a.firstName} {a.lastName}</Text>
                  {a.unreadCount > 0 && <View style={styles.unreadDot} />}
                </View>
                <View style={styles.tierBadge}>
                  <Text style={styles.tierText}>{TIER_LABELS[a.tier] ?? a.tier}</Text>
                </View>
              </View>

              {/* Row 2: last session + score */}
              <View style={styles.cardMeta}>
                <Text style={styles.metaText} numberOfLines={1}>
                  {a.lastSession
                    ? `Last: ${a.lastSession.name} · ${fmtDate(a.lastSession.completedAt)}`
                    : 'No sessions logged'}
                </Text>
                <View style={styles.scoreRow}>
                  {a.score !== null ? (
                    <>
                      <View style={[styles.scoreDot, { backgroundColor: scoreColor(a.score) }]} />
                      <Text style={[styles.scoreNum, { color: scoreColor(a.score) }]}>
                        {a.score}
                      </Text>
                    </>
                  ) : (
                    <Text style={styles.metaText}>--</Text>
                  )}
                </View>
              </View>
            </TouchableOpacity>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function SkeletonCard() {
  return (
    <View style={[styles.card, styles.skeletonCard]}>
      <View style={styles.skeletonName} />
      <View style={styles.skeletonMeta} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  heading: {
    color: Colors.textPrimary,
    fontSize: 28,
    fontWeight: '600',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 16,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 32,
    gap: 10,
  },
  card: {
    backgroundColor: Colors.card,
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  name: {
    color: Colors.textPrimary,
    fontSize: 16,
    fontWeight: '600',
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.accent,
  },
  tierBadge: {
    backgroundColor: '#1e1e00',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  tierText: {
    color: Colors.accent,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  cardMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  metaText: {
    color: Colors.textSecondary,
    fontSize: 13,
    flex: 1,
  },
  scoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginLeft: 12,
  },
  scoreDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  scoreNum: {
    fontFamily: Fonts.metric,
    fontSize: 16,
  },
  empty: {
    color: Colors.textSecondary,
    fontSize: 15,
    textAlign: 'center',
    marginTop: 80,
  },
  skeletonCard: {
    gap: 10,
  },
  skeletonName: {
    height: 16,
    width: '55%',
    backgroundColor: Colors.nested,
    borderRadius: 4,
  },
  skeletonMeta: {
    height: 13,
    width: '80%',
    backgroundColor: Colors.nested,
    borderRadius: 4,
  },
});
