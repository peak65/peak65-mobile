import React, { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import type { Session } from '@supabase/supabase-js';

import { supabase } from '../lib/supabase';
import LoginScreen from './auth/login';
import SignupScreen from './auth/signup';
import OnboardingScreen from './onboarding/index';
import GeneratingScreen from './(main)/generating';
import HomeScreen from './(main)/home';
import ProgramScreen from './(main)/program';
import HistoryScreen from './(main)/history';
import ProfileScreen from './(main)/profile';

// ─── Shared types used across screens ────────────────────────────────────────

export type ExerciseItem = {
  name: string;
  type?: 'strength' | 'cardio' | 'mobility';
  sets?: number;
  reps?: string;
  rest_seconds?: number;
  distance?: string;
  zone?: string;
  duration?: string;
  note?: string;
  notes?: string;
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
};

export type TabParamList = {
  Home: undefined;
  Program: undefined;
  History: undefined;
  Profile: undefined;
};

// ─── Navigators ───────────────────────────────────────────────────────────────

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const MainStack = createNativeStackNavigator<MainStackParamList>();
const Tab      = createBottomTabNavigator<TabParamList>();

const YELLOW = '#e8ff47';
const GREY   = '#8a877f';

const TAB_ICONS: Record<keyof TabParamList, string> = {
  Home:    '⌂',
  Program: '▦',
  History: '◷',
  Profile: '◉',
};

function MainTabs() {
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
      <MainStack.Screen name="Onboarding" component={OnboardingScreen} />
      <MainStack.Screen name="Generating" component={GeneratingScreen} />
      <MainStack.Screen name="Tabs"       component={MainTabs} />
    </MainStack.Navigator>
  );
}

// ─── App state resolution ─────────────────────────────────────────────────────

type AppState = 'loading' | 'unauthenticated' | 'onboarding' | 'generating' | 'authenticated';

async function resolveAppState(session: Session | null): Promise<AppState> {
  if (!session) return 'unauthenticated';

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('first_name')
    .eq('id', session.user.id)
    .maybeSingle();

  console.log('[resolveAppState] userId:', session.user.id);
  console.log('[resolveAppState] profile:', JSON.stringify(profile));
  console.log('[resolveAppState] profileError:', JSON.stringify(profileError));

  if (!profile?.first_name) return 'onboarding';

  const { data: program } = await supabase
    .from('programs')
    .select('id')
    .eq('user_id', session.user.id)
    .limit(1)
    .maybeSingle();

  return program ? 'authenticated' : 'generating';
}

// ─── Root layout ──────────────────────────────────────────────────────────────

export default function RootLayout() {
  const [appState, setAppState] = useState<AppState>('loading');

  useEffect(() => {
    // INITIAL_SESSION fires after the Supabase client finishes reading the
    // persisted session from AsyncStorage — the earliest safe point to query.
    // getSession() can race against that read and return null even when a
    // valid session exists, causing the user to be routed to onboarding.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        // Token refresh doesn't change routing — skip to avoid remounting the navigator.
        if (event === 'TOKEN_REFRESHED') return;

        // For INITIAL_SESSION the state is already 'loading' (initial useState),
        // so we don't need to set it again. For all other events reset to loading
        // so the navigator unmounts cleanly before the new route is determined.
        if (event !== 'INITIAL_SESSION') setAppState('loading');

        setAppState(await resolveAppState(session));
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  if (appState === 'loading') return null;

  if (appState === 'unauthenticated') {
    return (
      <NavigationContainer>
        <AuthNavigator />
      </NavigationContainer>
    );
  }

  const initialRoute: keyof MainStackParamList =
    appState === 'authenticated' ? 'Tabs' :
    appState === 'generating'    ? 'Generating' :
                                   'Onboarding';

  return (
    <NavigationContainer>
      <MainNavigator initialRoute={initialRoute} />
    </NavigationContainer>
  );
}
