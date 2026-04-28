import React, { useEffect, useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Session } from '@supabase/supabase-js';

import { supabase } from '../lib/supabase';
import LoginScreen from './auth/login';
import SignupScreen from './auth/signup';
import DashboardScreen from './(main)/dashboard';
import OnboardingScreen from './onboarding/index';

// --- Type definitions exported so screens can use them ---

export type AuthStackParamList = {
  Login: undefined;
  Signup: undefined;
};

export type MainStackParamList = {
  Onboarding: undefined;
  Dashboard: undefined;
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
    </MainStack.Navigator>
  );
}

// --- Root layout ---

async function fetchOnboardingComplete(userId: string): Promise<boolean> {
  const { data } = await supabase
    .from('profiles')
    .select('first_name')
    .eq('id', userId)
    .single();
  return !!data?.first_name;
}

export default function RootLayout() {
  const [session, setSession] = useState<Session | null>(null);
  const [onboardingComplete, setOnboardingComplete] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // On mount: resolve session, then check profile if logged in
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setSession(session);
      if (session) {
        setOnboardingComplete(await fetchOnboardingComplete(session.user.id));
      }
      setLoading(false);
    });

    // On auth state changes (sign-in / sign-out), re-check profile
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        setSession(session);
        if (session) {
          setOnboardingComplete(await fetchOnboardingComplete(session.user.id));
        } else {
          setOnboardingComplete(false);
        }
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  // Don't render until session + profile check are both done
  if (loading) return null;

  return (
    <NavigationContainer>
      {session
        ? <MainNavigator onboardingComplete={onboardingComplete} />
        : <AuthNavigator />}
    </NavigationContainer>
  );
}
