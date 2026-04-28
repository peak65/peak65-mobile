import React, { useEffect, useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { Session } from '@supabase/supabase-js';

import { supabase } from '../lib/supabase';
import LoginScreen from './auth/login';
import SignupScreen from './auth/signup';
import DashboardScreen from './(main)/dashboard';
import CheckinScreen from './(main)/checkin';
import OnboardingScreen from './onboarding/index';

// --- Type definitions exported so screens can use them ---

export type AuthStackParamList = {
  Login: undefined;
  Signup: undefined;
};

export type MainStackParamList = {
  Onboarding: undefined;
  Dashboard: undefined;
  Checkin: undefined;
};

// --- Stack navigators ---

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const MainStack = createNativeStackNavigator<MainStackParamList>();

function AuthNavigator() {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false }}>
      <AuthStack.Screen name="Login" component={LoginScreen} />
      <AuthStack.Screen name="Signup" component={SignupScreen} />
    </AuthStack.Navigator>
  );
}

function MainNavigator({ onboardingComplete }: { onboardingComplete: boolean }) {
  return (
    <MainStack.Navigator
      screenOptions={{ headerShown: false }}
      initialRouteName={onboardingComplete ? 'Dashboard' : 'Onboarding'}
    >
      <MainStack.Screen name="Onboarding" component={OnboardingScreen} />
      <MainStack.Screen name="Dashboard" component={DashboardScreen} />
      <MainStack.Screen name="Checkin" component={CheckinScreen} />
    </MainStack.Navigator>
  );
}

// --- Root layout ---

type AppState = 'loading' | 'unauthenticated' | 'onboarding' | 'authenticated';

// Resolves the full app state from a session in one async step,
// so the navigator never renders with partially-updated state.
async function resolveAppState(session: Session | null): Promise<AppState> {
  if (!session) return 'unauthenticated';

  const { data } = await supabase
    .from('profiles')
    .select('first_name')
    .eq('id', session.user.id)
    .single();

  return data?.first_name ? 'authenticated' : 'onboarding';
}

export default function RootLayout() {
  const [appState, setAppState] = useState<AppState>('loading');

  useEffect(() => {
    // Check the session once on mount and resolve the full app state.
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setAppState(await resolveAppState(session));
    });

    // React to future auth events (sign-in, sign-out, token refresh).
    // Skip INITIAL_SESSION — that's already handled by getSession() above.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (event === 'INITIAL_SESSION') return;
        setAppState('loading');
        setAppState(await resolveAppState(session));
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  // Hold the splash until we know exactly where to send the user.
  if (appState === 'loading') return null;

  return (
    <NavigationContainer>
      {appState === 'unauthenticated'
        ? <AuthNavigator />
        : <MainNavigator onboardingComplete={appState === 'authenticated'} />}
    </NavigationContainer>
  );
}
