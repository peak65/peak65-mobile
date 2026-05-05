import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import type { Session } from '@supabase/supabase-js';

import { supabase } from '../lib/supabase';
import { detectCandidates } from '../lib/sessionMatcher';
import LoginScreen from './auth/login';
import SignupScreen from './auth/signup';
import OnboardingScreen from './onboarding/index';
import GeneratingScreen from './(main)/generating';
import HomeScreen from './(main)/home';
import ProgramScreen from './(main)/program';
import HistoryScreen from './(main)/history';
import ProfileScreen from './(main)/profile';
import LiveWorkoutScreen from './(main)/live-workout';
import WaitingScreen from './(main)/waiting';
import CoachScreen from './(main)/coach';
import CoachAthleteScreen from './(main)/coach-athlete';
import UpdateProgramScreen from './(main)/update-program';

// ─── Shared types used across screens ────────────────────────────────────────

export type ExerciseItem = {
  name: string;
  type?: 'strength' | 'cardio' | 'mobility';
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
  LiveWorkout: { sessionJson: string; programId: string; weekNumber: number; dayName: string };
  Waiting: undefined;
  CoachAthleteDetail: { athleteId: string };
  UpdateProgram: undefined;
};

export type TabParamList = {
  Home: undefined;
  Program: undefined;
  History: undefined;
  Coach: undefined;
  Profile: undefined;
};

// ─── Navigators ───────────────────────────────────────────────────────────────

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const MainStack = createNativeStackNavigator<MainStackParamList>();
const Tab       = createBottomTabNavigator<TabParamList>();

const YELLOW = '#e8ff47';
const GREY   = '#8a877f';

const TAB_ICONS: Record<keyof TabParamList, string> = {
  Home:    '⌂',
  Program: '▦',
  History: '◷',
  Coach:   '◈',
  Profile: '◉',
};

// Context that makes isCoach available to MainTabs without prop drilling
// through the navigator's component= API.
const CoachContext = React.createContext(false);

function MainTabs() {
  const isCoach = React.useContext(CoachContext);

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#111111',
          borderTopWidth: 0,
          elevation: 0,
          shadowOpacity: 0,
        },
        tabBarActiveTintColor: YELLOW,
        tabBarInactiveTintColor: GREY,
        tabBarIcon: ({ color }) => (
          <Text style={{ color, fontSize: 20, lineHeight: 24 }}>
            {TAB_ICONS[route.name as keyof TabParamList]}
          </Text>
        ),
      })}
    >
      <Tab.Screen name="Home"    component={HomeScreen} />
      <Tab.Screen name="Program" component={ProgramScreen} />
      <Tab.Screen name="History" component={HistoryScreen} />
      {isCoach && <Tab.Screen name="Coach" component={CoachScreen} />}
      <Tab.Screen name="Profile" component={ProfileScreen} />
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
      <MainStack.Screen name="LiveWorkout"       component={LiveWorkoutScreen} />
      <MainStack.Screen name="Waiting"           component={WaitingScreen} />
      <MainStack.Screen name="CoachAthleteDetail" component={CoachAthleteScreen} />
      <MainStack.Screen name="UpdateProgram"     component={UpdateProgramScreen} />
    </MainStack.Navigator>
  );
}

// ─── App state resolution ─────────────────────────────────────────────────────

type AppState = 'loading' | 'unauthenticated' | 'onboarding' | 'generating' | 'authenticated';

async function resolveAppState(
  session: Session | null,
): Promise<{ state: AppState; isCoach: boolean }> {
  if (!session) return { state: 'unauthenticated', isCoach: false };

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('first_name')
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

  // Verify the user still exists in Supabase Auth (catches deleted-user cached sessions).
  const { error: userError } = await supabase.auth.getUser();
  if (userError) {
    await supabase.auth.signOut();
    return { state: 'unauthenticated', isCoach: false };
  }

  if (!profile?.first_name) return { state: 'onboarding', isCoach: false };

  // Check program existence and coach status in parallel.
  // If the coaches table doesn't exist yet, coachRes.error will be set — default to false.
  const [programRes, coachRes] = await Promise.all([
    supabase
      .from('programs')
      .select('id')
      .eq('user_id', session.user.id)
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
  const [appState, setAppState] = useState<AppState>('loading');
  const [isCoach, setIsCoach]   = useState(false);

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

          // For INITIAL_SESSION the state is already 'loading' (initial useState),
          // so we don't need to set it again. For all other events reset to loading
          // so the navigator unmounts cleanly before the new route is determined.
          if (event !== 'INITIAL_SESSION') setAppState('loading');

          const { state: newState, isCoach: newIsCoach } = await resolveAppState(session);
          setAppState(newState);
          setIsCoach(newIsCoach);

          if (newState === 'authenticated' && session?.user?.id) {
            detectCandidates(session.user.id).catch(() => {});
          }
        } catch (err) {
          console.log('[layout] auth handler error:', err);
          setAppState('unauthenticated');
        }
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  if (appState === 'loading') return null;

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
        <NavigationContainer>
          <MainNavigator initialRoute={initialRoute} />
        </NavigationContainer>
      </CoachContext.Provider>
    </ErrorBoundary>
  );
}
