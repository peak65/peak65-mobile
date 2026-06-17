import React, { useEffect, useRef, useState } from 'react';
import { Animated, Image, Platform, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import type { Session } from '@supabase/supabase-js';
import {
  useFonts,
  BarlowCondensed_700Bold,
  BarlowCondensed_900Black,
} from '@expo-google-fonts/barlow-condensed';
import * as SplashScreen from 'expo-splash-screen';
import * as Notifications from 'expo-notifications';
import { Feather } from '@expo/vector-icons';
import { MessageSquare } from 'lucide-react-native';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert:  true,
    shouldShowBanner: true,
    shouldShowList:   true,
    shouldPlaySound:  true,
    shouldSetBadge:   true,
  }),
});

import { supabase } from '../lib/supabase';
import { detectCandidates } from '../lib/sessionMatcher';
import { Colors } from '../lib/theme';
import LoginScreen from './auth/login';
import SignupScreen from './auth/signup';
import OnboardingScreen from './onboarding/index';
import GeneratingScreen from './(main)/generating';
import HomeScreen from './(main)/home';
import ProgramScreen from './(main)/program';
import HistoryScreen from './(main)/history';
import ProfileScreen from './(main)/profile';
import WaitingScreen from './(main)/waiting';
import CoachScreen from './(main)/coach';
import CoachAthleteScreen from './(main)/coach-athlete';
import UpdateProgramScreen from './(main)/update-program';
import MessagesScreen from './(main)/messages';
import LogSessionScreen from './(main)/log-session';

// ─── Shared types used across screens ────────────────────────────────────────

export type ExerciseItem = {
  name: string;
  type?: 'strength' | 'cardio' | 'mobility' | 'bodyweight';
  is_bodyweight?: boolean;
  sets?: number;
  reps?: string;
  rest?: string;
  rest_seconds?: number;
  distance?: string;
  zone?: string;
  duration?: string;
  note?: string;
  notes?: string;
  superset_id?: string | null;
  circuit_id?: string | null;
  circuit_rounds?: number | null;
  circuit_rest?: string | null;
  block_id?: string | null;
  block_name?: string | null;
  emom_id?: string | null;
  emom_label?: string | null;
  emom_rounds?: number | null;
  emom_total_minutes?: number | null;
  time_window?: string | null;
};

export type SessionBlock = {
  block_name: string;
  exercises: ExerciseItem[];
};

export type ProgramSession = {
  name: string;
  time: string;
  duration_minutes: number;
  description: string;
  blocks: SessionBlock[];
  log_result?: boolean;
  log_label?: string;
  log_field?: string;
};

export type ProgramDay = {
  day: string;
  day_index?: number;
  type: string;
  sessions: ProgramSession[];
  session_type?: string;
  intensity?: 'easy' | 'moderate' | 'hard' | 'rest';
  is_rest?: boolean;
  warm_up?: ExerciseItem[];
  main_work?: ExerciseItem[];
  cool_down?: ExerciseItem[];
};

export type Program = {
  id: string;
  user_id: string;
  created_at: string;
  week_start_date: string;
  week_number: number;
  program_data: {
    days: ProgramDay[];
  };
};

// ─── Nav param lists ──────────────────────────────────────────────────────────

export type AuthStackParamList = {
  Login: undefined;
  Signup: undefined;
};

export type MainStackParamList = {
  Onboarding: undefined;
  Generating: undefined;
  Tabs: undefined;
  LogSession: { sessionJson: string; programId: string; weekNumber: number; dayName: string };
  Waiting: undefined;
  CoachAthleteDetail: { athleteId: string };
  UpdateProgram: undefined;
};

export type TabParamList = {
  Home: undefined;
  Program: undefined;
  History: undefined;
  Messages: undefined;
  Coach: undefined;
  Profile: undefined;
};

// ─── Navigators ───────────────────────────────────────────────────────────────

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const MainStack = createNativeStackNavigator<MainStackParamList>();
const Tab       = createBottomTabNavigator<TabParamList>();

const TAB_ICON_NAMES: Record<keyof TabParamList, React.ComponentProps<typeof Feather>['name']> = {
  Home:     'home',
  Program:  'clipboard',
  History:  'clock',
  Messages: 'message-square',
  Coach:    'activity',
  Profile:  'user',
};

// Context that makes isCoach available to MainTabs without prop drilling
// through the navigator's component= API.
const CoachContext = React.createContext(false);

export const UnreadContext = React.createContext<{
  hasUnread: boolean;
  setHasUnread: (v: boolean) => void;
}>({ hasUnread: false, setHasUnread: () => {} });

function MainTabs() {
  const isCoach           = React.useContext(CoachContext);
  const { hasUnread }     = React.useContext(UnreadContext);

  return (
    <Tab.Navigator
      screenOptions={({ route }) => {
        const iconName = TAB_ICON_NAMES[route.name as keyof TabParamList];
        return {
          headerShown: false,
          tabBarStyle: {
            backgroundColor: Colors.background,
            borderTopWidth: 1,
            borderTopColor: Colors.border,
            elevation: 0,
            shadowOpacity: 0,
          },
          tabBarActiveTintColor:   Colors.accent,
          tabBarInactiveTintColor: Colors.textSecondary,
          tabBarIcon: ({ color }) => (
            <View>
              {route.name === 'Messages'
                ? <MessageSquare color={color} size={24} strokeWidth={1.5} />
                : <Feather name={iconName} color={color} size={24} />
              }
              {route.name === 'Messages' && hasUnread && (
                <View style={{ position: 'absolute', top: 0, right: -4, width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.accent }} />
              )}
            </View>
          ),
        };
      }}
    >
      <Tab.Screen name="Home"     component={HomeScreen} />
      <Tab.Screen name="Program"  component={ProgramScreen} />
      <Tab.Screen name="History"  component={HistoryScreen} />
      <Tab.Screen name="Messages" component={MessagesScreen} />
      {isCoach && <Tab.Screen name="Coach" component={CoachScreen} />}
      <Tab.Screen name="Profile"  component={ProfileScreen} />
    </Tab.Navigator>
  );
}

function AuthNavigator() {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false }}>
      <AuthStack.Screen name="Login"  component={LoginScreen} />
      <AuthStack.Screen name="Signup" component={SignupScreen} />
    </AuthStack.Navigator>
  );
}

function MainNavigator({ initialRoute }: { initialRoute: keyof MainStackParamList }) {
  return (
    <MainStack.Navigator screenOptions={{ headerShown: false }} initialRouteName={initialRoute}>
      <MainStack.Screen name="Onboarding"        component={OnboardingScreen} />
      <MainStack.Screen name="Generating"        component={GeneratingScreen} />
      <MainStack.Screen name="Tabs"              component={MainTabs} />
      <MainStack.Screen name="LogSession"        component={LogSessionScreen} options={{ headerShown: false }} />
      <MainStack.Screen name="Waiting"           component={WaitingScreen} />
      <MainStack.Screen name="CoachAthleteDetail" component={CoachAthleteScreen} />
      <MainStack.Screen name="UpdateProgram"     component={UpdateProgramScreen} />
    </MainStack.Navigator>
  );
}

// ─── Push token registration ─────────────────────────────────────────────────

async function checkUnread(userId: string): Promise<boolean> {
  const { count } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('athlete_id', userId)
    .is('read_at', null)
    .neq('sender_id', userId);
  return (count ?? 0) > 0;
}

async function registerPushToken(userId: string) {
  if (Platform.OS !== 'ios') return;
  try {
    const { status: existing } = await Notifications.getPermissionsAsync();
    const finalStatus = existing === 'granted'
      ? existing
      : (await Notifications.requestPermissionsAsync()).status;
    if (finalStatus !== 'granted') return;

    const { data: tokenData } = await Notifications.getDevicePushTokenAsync();
    const token = tokenData as string | undefined;
    if (!token) return;

    await supabase
      .from('profiles')
      .update({ expo_push_token: token })
      .eq('id', userId);
  } catch (err) {
    console.log('[registerPushToken] error:', err);
  }
}

// ─── App state resolution ─────────────────────────────────────────────────────

type AppState = 'loading' | 'unauthenticated' | 'onboarding' | 'generating' | 'authenticated';

async function resolveAppState(
  session: Session | null,
): Promise<{ state: AppState; isCoach: boolean }> {
  if (!session) return { state: 'unauthenticated', isCoach: false };

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('first_name, role')
    .eq('id', session.user.id)
    .maybeSingle();

  console.log('[resolveAppState] userId:', session.user.id);
  console.log('[resolveAppState] profile:', JSON.stringify(profile));
  console.log('[resolveAppState] profileError:', JSON.stringify(profileError));

  // Profile query errored — session is likely stale or DB access was denied.
  if (profileError) {
    await supabase.auth.signOut();
    return { state: 'unauthenticated', isCoach: false };
  }

  if (profile?.role === 'coach') {
    return { state: 'authenticated', isCoach: true };
  }

  if (!profile?.first_name) return { state: 'onboarding', isCoach: false };

  // Check program existence and coach status in parallel.
  // If the coaches table doesn't exist yet, coachRes.error will be set — default to false.
  const [programRes, coachRes] = await Promise.all([
    supabase
      .from('programs')
      .select('id')
      .eq('user_id', session.user.id)
      .not('is_draft', 'is', true)
      .limit(1)
      .maybeSingle(),
    supabase
      .from('coaches')
      .select('id')
      .eq('id', session.user.id)
      .maybeSingle(),
  ]);

  const isCoach = !coachRes.error && !!coachRes.data;
  const state: AppState = programRes.data ? 'authenticated' : 'generating';

  return { state, isCoach };
}

// ─── Branded loading screen ──────────────────────────────────────────────────

function BrandedLoadingScreen() {
  const scale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.08, duration: 600, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1.0,  duration: 600, useNativeDriver: true }),
      ]),
    ).start();
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: '#080808', alignItems: 'center', justifyContent: 'center' }}>
      <Animated.Image
        source={require('../assets/peak65-logo.png')}
        style={{ width: 200, height: 200 / 1.95, transform: [{ scale }] }}
        resizeMode="contain"
      />
    </View>
  );
}

// ─── Error boundary ───────────────────────────────────────────────────────────

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; crashCount: number }
> {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, crashCount: 0 };
  }

  static getDerivedStateFromError(): Partial<{ hasError: boolean }> {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.log('[ErrorBoundary] caught:', error?.message, info?.componentStack?.slice(0, 500));
    try {
      void supabase.from('crash_logs').insert({
        error_message: String(error?.message ?? '').slice(0, 500),
        error_stack:   String(info?.componentStack ?? '').slice(0, 2000),
        app_version:   '1.0',
      });
    } catch {}
  }

  componentDidUpdate(_: any, prev: { hasError: boolean; crashCount: number }) {
    if (!prev.hasError && this.state.hasError) {
      const next = this.state.crashCount + 1;
      if (next >= 2) {
        this.setState({ crashCount: next });
        return;
      }
      this.timer = setTimeout(() => {
        AsyncStorage.getAllKeys()
          .then(keys => {
            const toClear = (keys ?? []).filter(k => !k.startsWith('sb-'));
            return toClear.length > 0 ? AsyncStorage.multiRemove(toClear) : Promise.resolve();
          })
          .catch(() => {})
          .finally(() => this.setState({ hasError: false, crashCount: next }));
      }, 3000);
    }
  }

  componentWillUnmount() {
    if (this.timer) clearTimeout(this.timer);
  }

  render() {
    const { hasError, crashCount } = this.state;
    if (!hasError) return this.props.children as React.ReactElement;
    if (crashCount >= 2) {
      return (
        <View style={{ flex: 1, backgroundColor: '#080808', alignItems: 'center', justifyContent: 'center', padding: 32 }}>
          <Text style={{ color: '#e8ff47', fontSize: 36, fontWeight: '800', letterSpacing: -1, marginBottom: 20 }}>Peak 65</Text>
          <Text style={{ color: '#f0ede8', fontSize: 16, textAlign: 'center', lineHeight: 24 }}>Something went wrong. We're on it.</Text>
        </View>
      );
    }
    return <View style={{ flex: 1, backgroundColor: '#080808' }} />;
  }
}

// ─── Root layout ──────────────────────────────────────────────────────────────

export default function RootLayout() {
  const [appState,   setAppState]   = useState<AppState>('loading');
  const [isCoach,    setIsCoach]    = useState(false);
  const [hasUnread,  setHasUnread]  = useState(false);
  const resolvingRef                = React.useRef(false);
  const appStateValueRef            = React.useRef(appState);
  appStateValueRef.current          = appState;

  const [fontsLoaded] = useFonts({
    BarlowCondensed_700Bold,
    BarlowCondensed_900Black,
  });

  useEffect(() => {
    if (fontsLoaded) {
      void SplashScreen.hideAsync().catch(() => {});
    }
  }, [fontsLoaded]);

  useEffect(() => {
    // INITIAL_SESSION fires after the Supabase client finishes reading the
    // persisted session from AsyncStorage — the earliest safe point to query.
    // getSession() can race against that read and return null even when a
    // valid session exists, causing the user to be routed to onboarding.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        try {
          // Token refresh doesn't change routing — skip to avoid remounting the navigator.
          if (event === 'TOKEN_REFRESHED') return;

          // One resolve at a time — if a resolve is already in progress, drop the
          // duplicate event (typically caused by rapid sign-in/sign-out races).
          if (resolvingRef.current) return;
          resolvingRef.current = true;

          // For INITIAL_SESSION the state is already 'loading' (initial useState),
          // so we don't need to set it again. For all other events reset to loading
          // so the navigator unmounts cleanly before the new route is determined.
          if (event !== 'INITIAL_SESSION') setAppState('loading');

          const resolveStart = Date.now();
          const { state: newState, isCoach: newIsCoach } = await Promise.race([
            resolveAppState(session),
            new Promise<{ state: AppState; isCoach: boolean }>(resolve =>
              setTimeout(() => resolve({ state: session ? 'authenticated' : 'unauthenticated', isCoach: false }), 10_000)
            ),
          ]);

          // 300ms minimum prevents a white flash when the splash transitions
          // out before the JS bridge has finished painting the first frame.
          const elapsed = Date.now() - resolveStart;
          if (elapsed < 300) await new Promise(r => setTimeout(r, 300 - elapsed));

          setAppState(newState);
          setIsCoach(newIsCoach);

          if (newState === 'authenticated' && session?.user?.id) {
            detectCandidates(session.user.id).catch(() => {});
            registerPushToken(session.user.id).catch(() => {});
            checkUnread(session.user.id).then(u => setHasUnread(u)).catch(() => {});
          }
        } catch (err) {
          console.log('[layout] auth handler error:', err);
          setAppState('unauthenticated');
        } finally {
          resolvingRef.current = false;
        }
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  // Watchdog: if loading is stuck for >20s (e.g. network totally unavailable),
  // fall back to unauthenticated so the user sees the login screen instead of a dark screen.
  useEffect(() => {
    if (appState !== 'loading') return;
    const t = setTimeout(() => {
      if (appStateValueRef.current === 'loading') {
        console.log('[layout] watchdog: loading stuck >20s, forcing unauthenticated');
        setAppState('unauthenticated');
      }
    }, 20_000);
    return () => clearTimeout(t);
  }, [appState]);

  if (appState === 'loading' || !fontsLoaded) return <BrandedLoadingScreen />;

  if (appState === 'unauthenticated') {
    return (
      <ErrorBoundary>
        <NavigationContainer>
          <AuthNavigator />
        </NavigationContainer>
      </ErrorBoundary>
    );
  }

  const initialRoute: keyof MainStackParamList =
    appState === 'authenticated' ? 'Tabs' :
    appState === 'generating'    ? 'Generating' :
                                   'Onboarding';

  return (
    <ErrorBoundary>
      <CoachContext.Provider value={isCoach}>
        <UnreadContext.Provider value={{ hasUnread, setHasUnread }}>
          <NavigationContainer>
            <MainNavigator initialRoute={initialRoute} />
          </NavigationContainer>
        </UnreadContext.Provider>
      </CoachContext.Provider>
    </ErrorBoundary>
  );
}
