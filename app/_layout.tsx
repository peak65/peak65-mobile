// First import, so APP_START is taken as early as the bundle allows.
import { perfLog, sinceAppStart } from '../lib/perf';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Image, Platform, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  NavigationContainer,
  createNavigationContainerRef,
  type NavigatorScreenParams,
} from '@react-navigation/native';
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
import { MessageSquare, WifiOff } from 'lucide-react-native';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert:  true,
    shouldShowBanner: true,
    shouldShowList:   true,
    shouldPlaySound:  true,
    shouldSetBadge:   true,
  }),
});

import { supabase, SUPABASE_AUTH_STORAGE_KEY } from '../lib/supabase';
import { clearUserCache } from '../lib/userCache';
import { cacheUsable } from '../lib/cachePolicy';
import { syncBadge } from '../lib/badge';
import { Colors } from '../lib/theme';
import { LEGAL_VERSION } from '../lib/legal';
import { excludeArchived } from '../lib/programFilters';
import LoginScreen from './auth/login';
import SignupScreen from './auth/signup';
import OnboardingScreen from './onboarding/index';
import PinnacleSetupScreen from './onboarding/pinnacle-setup';
import LegalAcceptScreen from './legal-accept';
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
  type?: 'strength' | 'cardio' | 'z2_cardio' | 'mobility' | 'bodyweight' | 'rest';
  is_bodyweight?: boolean;
  sets?: number;
  reps?: string;
  rest?: string;
  rest_seconds?: number;
  distance?: string;
  zone?: string;
  duration?: string;
  // Structured pace prescription. The AI generators write pace_target /
  // pace_zone; the coach editor writes `pace` (and ALSO packs the same value
  // into `notes` as "Pace: X | Load: Y | cue"). All three already arrive in the
  // raw program JSON — declared here so lib/pace.ts can read them without casts.
  pace_target?: string;
  pace_zone?: string;
  pace?: string;
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
  amrap_id?: string | null;
  amrap_label?: string | null;
  amrap_time_cap?: number | null;
  time_window?: string | null;
};

export type SessionBlock = {
  block_name: string;
  // Marks the session's main work block — the effort the session is built
  // around. Set by the AI generators and by the coach editor's "Work set"
  // checkbox, at most one per session. Already present in the raw JSON.
  is_work?: boolean;
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
  session_type?: string;   // per-session, web vocabulary ('total_body_strength','zone2','threshold',etc.)
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
  PinnacleSetup: undefined;
  // `next` is the state the account would have landed on without the gate;
  // the screen routes there once acceptance is recorded.
  LegalAccept: { next: AppState; fullName: string | null };
  Generating: undefined;
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
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

// Pinnacle status, resolved once in resolveAppState and read by the tabs.
// isElite gates every automatic program generator; awaitingProgram switches
// Home / Program / History to the "coach is building your program" state.
export const ProgramStatusContext = React.createContext<{
  isElite: boolean;
  awaitingProgram: boolean;
}>({ isElite: false, awaitingProgram: false });

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

function MainNavigator({
  initialRoute,
  legalParams,
}: {
  initialRoute: keyof MainStackParamList;
  legalParams: MainStackParamList['LegalAccept'];
}) {
  return (
    <MainStack.Navigator screenOptions={{ headerShown: false }} initialRouteName={initialRoute}>
      <MainStack.Screen name="Onboarding"        component={OnboardingScreen} />
      <MainStack.Screen name="PinnacleSetup"     component={PinnacleSetupScreen} />
      <MainStack.Screen
        name="LegalAccept"
        component={LegalAcceptScreen}
        initialParams={legalParams}
        options={{ gestureEnabled: false }}
      />
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

// ─── Notification taps ───────────────────────────────────────────────────────

// Attached to the main navigator only, so it is "ready" only while a signed-in
// user's stack is mounted — never on the auth screens or the loading screen.
const mainNavigationRef = createNavigationContainerRef<MainStackParamList>();

type TapKind = 'message' | 'program';

// The server puts `kind` next to `aps` in the APNs payload. For a remote push on
// iOS, expo-notifications 0.32 exposes that full payload as trigger.payload;
// content.data is only userInfo["body"], which this server doesn't send. Fall
// back to content.data in case a push ever nests it there.
function readTapKind(response: Notifications.NotificationResponse): TapKind | null {
  const { request } = response.notification;
  const payload = request.trigger && 'payload' in request.trigger ? request.trigger.payload : undefined;
  const kind = payload?.kind ?? request.content.data?.kind;
  return kind === 'message' || kind === 'program' ? kind : null;
}

// Root stack screens a tap may navigate away from. Anything before the app
// proper — LegalAccept, Onboarding, PinnacleSetup, Generating, Waiting — is
// excluded, so a tap can never skip the gate or strand a half-onboarded athlete.
const TAP_SAFE_ROUTES = new Set<keyof MainStackParamList>([
  'Tabs', 'LogSession', 'CoachAthleteDetail', 'UpdateProgram',
]);

// ─── App state resolution ─────────────────────────────────────────────────────

export type AppState = 'loading' | 'unauthenticated' | 'onboarding' | 'setup' | 'generating' | 'waiting' | 'authenticated' | 'legal' | 'offline';

// The startup queries could not complete — network down or a server error. This
// is NOT a sign-out: the athlete keeps their session and sees the offline state.
class TransientResolveError extends Error {}

// PostgREST reports a failed fetch (no network) as status 0.
function isTransientStatus(status: number): boolean {
  return status === 0 || status >= 500;
}

// Auth itself rejected the token. Only this, and a missing session, may send an
// athlete back to Login.
function isAuthRejection(status: number, code: string | undefined): boolean {
  return status === 401 || (code ?? '').startsWith('PGRST30');
}

// A non-draft program is what separates "ready to train" from "still waiting".
// Shared by the Pinnacle branch and the standard path below. Throws on a failed
// query: reading "no program" off a network error would route a trained athlete
// to the generator.
async function hasActiveProgram(userId: string): Promise<boolean> {
  const { data, error } = await excludeArchived(
    supabase
      .from('programs')
      .select('id')
      .eq('user_id', userId)
      .not('is_draft', 'is', true),
  )
    .limit(1)
    .maybeSingle();
  if (error) throw new TransientResolveError(`programs: ${error.message}`);
  return !!data;
}

// isElite / awaitingProgram are resolved here so the tabs never have to
// re-query them. Both default to false, so only the Pinnacle branch sets them.
type ResolveResult = {
  state: AppState;
  isCoach: boolean;
  isElite?: boolean;
  awaitingProgram?: boolean;
  // Set only when state is 'legal': where the account goes after accepting,
  // and the name recorded with the acceptance.
  next?: AppState;
  fullName?: string | null;
};

type Profile = {
  first_name: string | null;
  last_name: string | null;
  role: string | null;
  tier: string | null;
  program_status: string | null;
  onboarding_complete: boolean | null;
  legal_accepted_version: string | null;
};

async function resolveAppState(
  session: Session | null,
): Promise<ResolveResult> {
  if (!session) return { state: 'unauthenticated', isCoach: false };
  const uid = session.user.id;

  // All three lookups need only the user id, so they start together instead of
  // one after another. The routing below still consults them in the same order
  // and only on the same paths as before; the program check is simply already
  // in flight. It is marked handled here so the paths that never read it (a
  // coach, onboarding, setup) can't raise an unhandled rejection.
  const hasProgramP = hasActiveProgram(uid);
  hasProgramP.catch(() => {});

  const [profileRes, coachRes] = await Promise.all([
    supabase
      .from('profiles')
      .select('first_name, last_name, role, tier, program_status, onboarding_complete, legal_accepted_version')
      .eq('id', uid)
      .maybeSingle(),
    supabase
      .from('coaches')
      .select('id')
      .eq('id', uid)
      .maybeSingle(),
  ]);
  const { data: profile, error: profileError, status: profileStatus } = profileRes;

  // Never the row itself: it carries the athlete's name, role and tier.
  console.log('[resolveAppState] profile found:', !!profile, '| legal accepted:', profile?.legal_accepted_version === LEGAL_VERSION);
  console.log('[resolveAppState] profileError:', JSON.stringify(profileError));

  if (profileError) {
    // The token was rejected — the session really is over.
    if (isAuthRejection(profileStatus, profileError.code)) {
      await supabase.auth.signOut();
      return { state: 'unauthenticated', isCoach: false };
    }
    // Anything else (no network, a server error) says nothing about the session.
    throw new TransientResolveError(`profile: ${profileError.message}`);
  }

  // A network failure on the coaches lookup must not quietly route a coach as an
  // athlete. A missing table (a non-transient error) still means "not a coach".
  if (coachRes.error && isTransientStatus(coachRes.status)) {
    throw new TransientResolveError(`coaches: ${coachRes.error.message}`);
  }
  const isCoachMember = !coachRes.error && !!coachRes.data;

  const base = await resolveRoute(profile, isCoachMember, () => hasProgramP);

  // ── Legal gate ──────────────────────────────────────────────────────────────
  // Wraps the routing rather than sitting inside it, so every signed-in
  // account — coaches and admins included — passes through it. isElite and
  // awaitingProgram ride along so the tabs are configured correctly once the
  // account is let through; without them a Pinnacle athlete would reach Tabs
  // with the automatic program generators switched back on.
  if (profile?.legal_accepted_version !== LEGAL_VERSION) {
    const fullName = [profile?.first_name, profile?.last_name]
      .map(n => (n ?? '').trim())
      .filter(Boolean)
      .join(' ') || null;
    return {
      state:           'legal',
      isCoach:         base.isCoach,
      isElite:         base.isElite,
      awaitingProgram: base.awaitingProgram,
      next:            base.state,
      fullName,
    };
  }

  return base;
}

// Routing for a signed-in account whose profile loaded — where it belongs
// before the legal gate is applied.
async function resolveRoute(
  profile: Profile | null,
  isCoachMember: boolean,
  hasActiveProgramFn: () => Promise<boolean>,
): Promise<ResolveResult> {
  if (profile?.role === 'coach') {
    return { state: 'authenticated', isCoach: true };
  }

  // ── Coach status ────────────────────────────────────────────────────────────
  // Resolved once, up front, and BEFORE any tier branching. Membership in
  // `coaches` — not `role` — is the authoritative signal: staff accounts carry
  // role 'admin', which matches nothing above. Staff can also carry tier
  // 'elite', so if this ran after the Pinnacle branch below (as it once did)
  // that branch would swallow them and strip the Coach tab.
  // The lookup itself runs in parallel with the profile (resolveAppState); a
  // missing coaches table arrives here as false.
  if (isCoachMember) {
    return { state: 'authenticated', isCoach: true };
  }

  // Everything past this point is a non-coach athlete, so isCoach is false.

  // ── Pinnacle (tier 'elite') athletes ────────────────────────────────────────
  // Their coach writes the program by hand, so this path must never reach
  // 'generating' — that state auto-fires AI program generation on mount.
  // A coach's invite pre-fills first_name, so without this branch an elite
  // athlete would fall straight past the first_name check into that generator.
  // Once setup is done an elite athlete always enters the main app, with or
  // without a program — so they can message their coach and connect a wearable
  // while they wait. awaitingProgram tells the tabs to show the "your coach is
  // building your program" state instead of an empty one, and gates off the
  // automatic generators in Home and Program.
  if (profile?.tier === 'elite') {
    if (!profile?.onboarding_complete) return { state: 'setup', isCoach: false, isElite: true };
    const hasProgram = await hasActiveProgramFn();
    return { state: 'authenticated', isCoach: false, isElite: true, awaitingProgram: !hasProgram };
  }

  if (!profile?.first_name) return { state: 'onboarding', isCoach: false };

  const hasProgram = await hasActiveProgramFn();

  return { state: hasProgram ? 'authenticated' : 'generating', isCoach: false };
}

// ─── Slow and offline starts ─────────────────────────────────────────────────

// How long the logo may show before the app stops waiting on the network. The
// real resolution keeps running and takes over whenever it lands.
const FALLBACK_MS = 4_000;

// Whether a session is saved on the device, and whose. supabase-js keeps it
// under SUPABASE_AUTH_STORAGE_KEY until auth removes it (sign-out, or a rejected
// refresh token), so a present key means signed in even when the network can't
// confirm it. When INITIAL_SESSION arrives with null because an expired token
// could not be refreshed offline, this is what stops that athlete being sent to
// Login.
async function readStoredSession(): Promise<{ exists: boolean; userId: string | null }> {
  try {
    const raw = await AsyncStorage.getItem(SUPABASE_AUTH_STORAGE_KEY);
    if (!raw) return { exists: false, userId: null };
    try {
      const parsed = JSON.parse(raw);
      return { exists: true, userId: parsed?.user?.id ?? null };
    } catch {
      return { exists: true, userId: null };
    }
  } catch {
    // Storage unreadable — can't prove there's no session, so don't claim there isn't.
    return { exists: true, userId: null };
  }
}

// The last successful routing result, so a signed-in athlete can open the app
// offline. Only 'authenticated' is stored — never a pre-app state — and it is
// used only for the same user, under the same legal version, within
// CACHE_MAX_AGE_MS. The real resolution replaces it as soon as it lands.
const RESOLUTION_CACHE_KEY = 'resolution_cache';

type CachedResolution = {
  userId: string;
  legalVersion: string;
  savedAt: number;
  isCoach: boolean;
  isElite: boolean;
  awaitingProgram: boolean;
};

async function saveResolution(userId: string, r: ResolveResult): Promise<void> {
  if (r.state !== 'authenticated') return;
  const entry: CachedResolution = {
    userId,
    legalVersion:    LEGAL_VERSION,
    savedAt:         Date.now(),
    isCoach:         r.isCoach,
    isElite:         !!r.isElite,
    awaitingProgram: !!r.awaitingProgram,
  };
  try { await AsyncStorage.setItem(RESOLUTION_CACHE_KEY, JSON.stringify(entry)); } catch {}
}

async function readResolution(userId: string | null): Promise<ResolveResult | null> {
  if (!userId) return null;
  try {
    const raw = await AsyncStorage.getItem(RESOLUTION_CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as CachedResolution;
    if (c.userId !== userId || c.legalVersion !== LEGAL_VERSION || !cacheUsable(c.savedAt)) return null;
    return { state: 'authenticated', isCoach: c.isCoach, isElite: c.isElite, awaitingProgram: c.awaitingProgram };
  } catch {
    return null;
  }
}

// ─── Offline UI ──────────────────────────────────────────────────────────────

// Full screen: signed in, but nothing cached to show yet.
function OfflineScreen({ retrying, onRetry, onSignOut }: {
  retrying: boolean; onRetry: () => void; onSignOut: () => void;
}) {
  return (
    <View style={{ flex: 1, backgroundColor: Colors.background, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <Image
        source={require('../assets/peak65-logo.png')}
        style={{ width: 150, height: 150 / 1.95, marginBottom: 28 }}
        resizeMode="contain"
      />
      <Text style={{ color: Colors.textPrimary, fontSize: 17, fontWeight: '700', marginBottom: 8, textAlign: 'center' }}>
        Can't reach Peak 65
      </Text>
      <Text style={{ color: Colors.textSecondary, fontSize: 14, lineHeight: 20, textAlign: 'center', marginBottom: 24 }}>
        Check your connection. You're still signed in.
      </Text>
      <TouchableOpacity
        onPress={onRetry}
        disabled={retrying}
        style={{ backgroundColor: Colors.accent, borderRadius: 10, paddingVertical: 14, paddingHorizontal: 40, opacity: retrying ? 0.5 : 1 }}
      >
        <Text style={{ color: Colors.background, fontSize: 15, fontWeight: '700' }}>{retrying ? 'Retrying…' : 'Retry'}</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onSignOut} style={{ marginTop: 18, padding: 8 }}>
        <Text style={{ color: Colors.textSecondary, fontSize: 13 }}>Sign out</Text>
      </TouchableOpacity>
    </View>
  );
}

// Small strip over the app while it runs on its saved routing result.
function OfflineBanner({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  return (
    <SafeAreaView edges={['top']} pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'center' }}>
      <TouchableOpacity
        onPress={onRetry}
        disabled={retrying}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: Colors.nested, borderRadius: 14, paddingVertical: 5, paddingHorizontal: 12, marginTop: 4 }}
      >
        <WifiOff color={Colors.textSecondary} size={13} strokeWidth={2} />
        <Text style={{ color: Colors.textSecondary, fontSize: 12 }}>
          {retrying ? 'Reconnecting…' : 'Offline · showing saved data · Retry'}
        </Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
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
  const [isElite,    setIsElite]    = useState(false);
  const [awaitingProgram, setAwaitingProgram] = useState(false);
  const [hasUnread,  setHasUnread]  = useState(false);
  const [legalParams, setLegalParams] = useState<MainStackParamList['LegalAccept']>({ next: 'authenticated', fullName: null });
  // Increments per resolution so only the newest result is applied.
  const resolveGenRef               = React.useRef(0);
  const appStateValueRef            = React.useRef(appState);
  appStateValueRef.current          = appState;
  // Set while the network can't confirm the athlete: 'cached' shows the app from
  // the saved routing result with a banner, 'screen' is the full offline screen.
  const [offlineMode, setOfflineMode] = useState<'cached' | 'screen' | null>(null);
  const offlineModeRef              = React.useRef(offlineMode);
  offlineModeRef.current            = offlineMode;
  const [retrying, setRetrying]     = useState(false);
  const isCoachRef                  = React.useRef(isCoach);
  isCoachRef.current                = isCoach;

  // A tapped notification waiting for the main navigator to be ready.
  const pendingTapRef               = React.useRef<TapKind | null>(null);
  const handledTapIdsRef            = React.useRef(new Set<string>());

  // Acts on a pending tap once the main navigator is mounted. Checks the screen
  // actually showing rather than appState: after the legal gate or onboarding
  // hands off with navigation.replace, appState keeps its old value, but the
  // route tells the truth. A tap that lands on a pre-app screen is dropped.
  const flushPendingTap = React.useCallback(() => {
    const kind = pendingTapRef.current;
    if (!kind || !mainNavigationRef.isReady()) return;
    pendingTapRef.current = null;

    const root = mainNavigationRef.getRootState();
    const current = root?.routes[root.index ?? 0]?.name as keyof MainStackParamList | undefined;
    if (!current || !TAP_SAFE_ROUTES.has(current)) return;

    // Coaches read athlete messages from the Coach tab; their Messages tab is
    // the athlete-side thread, not their inbox.
    const screen: keyof TabParamList =
      kind === 'program' ? 'Program' :
      isCoachRef.current ? 'Coach' :
                           'Messages';
    mainNavigationRef.navigate('Tabs', { screen });
  }, []);

  // Notification taps: the listener covers a running app; the last response
  // covers a cold launch from a tap. Both feed the same pending slot, deduped by
  // notification id, and flushPendingTap waits for the navigator to be ready.
  useEffect(() => {
    let active = true;

    function handleResponse(response: Notifications.NotificationResponse) {
      if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
      const id = response.notification.request.identifier;
      if (handledTapIdsRef.current.has(id)) return;
      handledTapIdsRef.current.add(id);
      // Consumed — a later JS reload must not replay this tap.
      Notifications.clearLastNotificationResponseAsync().catch(() => {});

      const kind = readTapKind(response);
      if (!kind) return;
      pendingTapRef.current = kind;
      flushPendingTap();
    }

    const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
    Notifications.getLastNotificationResponseAsync()
      .then(response => { if (active && response) handleResponse(response); })
      .catch(() => {});

    return () => {
      active = false;
      subscription.remove();
    };
  }, [flushPendingTap]);

  const [fontsLoaded] = useFonts({
    BarlowCondensed_700Bold,
    BarlowCondensed_900Black,
  });

  useEffect(() => {
    if (fontsLoaded) {
      void SplashScreen.hideAsync().catch(() => {});
    }
  }, [fontsLoaded]);

  // Applies a routing result. `fromCache` marks a saved result shown while the
  // network is unreachable: it drives the offline banner, and the post-auth
  // network work waits for a real resolution.
  const applyResult = React.useCallback((r: ResolveResult, userId: string | null, fromCache: boolean) => {
    setAppState(r.state);
    setIsCoach(r.isCoach);
    setIsElite(!!r.isElite);
    setAwaitingProgram(!!r.awaitingProgram);
    setLegalParams({ next: r.next ?? 'authenticated', fullName: r.fullName ?? null });
    setOfflineMode(fromCache ? 'cached' : null);

    if (!fromCache && r.state === 'authenticated' && userId) {
      void saveResolution(userId, r);
      // detectCandidates runs from Home's load, which follows immediately.
      registerPushToken(userId).catch(() => {});
      checkUnread(userId).then(u => setHasUnread(u)).catch(() => {});
      void syncBadge(userId);
    }
  }, []);

  // Network couldn't confirm anything, but a session is saved on the device.
  // Show the app from the saved routing result if there is one, otherwise the
  // offline screen — never Login.
  const enterFallback = React.useCallback(async (userId: string | null, why: string) => {
    const cached = await readResolution(userId);
    // A real resolution may have landed while storage was being read.
    if (appStateValueRef.current !== 'loading' && offlineModeRef.current === null) return;
    console.log(`[layout] offline fallback (${why}) — ${cached ? 'using saved routing' : 'no saved routing'}`);
    if (cached) applyResult(cached, userId, true);
    else { setOfflineMode('screen'); setAppState('offline'); }
  }, [applyResult]);

  // Runs the real resolution. The newest call wins: a result from an older call
  // is dropped instead of overwriting a newer one.
  const runResolve = React.useCallback(async (session: Session | null, reason: string) => {
    const gen = ++resolveGenRef.current;
    const started = Date.now();
    try {
      const r = await resolveAppState(session);
      if (gen !== resolveGenRef.current) return;
      perfLog('startup chain', Date.now() - started, `${reason}, state=${r.state}`);

      // 300ms minimum prevents a white flash when the splash transitions
      // out before the JS bridge has finished painting the first frame.
      const elapsed = Date.now() - started;
      if (elapsed < 300) await new Promise(res => setTimeout(res, 300 - elapsed));
      if (gen !== resolveGenRef.current) return;

      applyResult(r, session?.user?.id ?? null, false);
    } catch (err) {
      if (gen !== resolveGenRef.current) return;
      perfLog('startup chain', Date.now() - started, `${reason}, failed`);
      console.log('[layout] resolve failed:', err instanceof Error ? err.message : err);
      // Already showing the app from saved routing, or the offline screen — stay.
      if (appStateValueRef.current === 'loading') await enterFallback(session?.user?.id ?? null, 'resolve failed');
    }
  }, [applyResult, enterFallback]);

  // Resolves for a session that may be null. Null goes to Login only when no
  // session is saved on the device; a saved one means the network, not the
  // athlete, is the problem.
  const handleSession = React.useCallback(async (session: Session | null, reason: string) => {
    if (session) { await runResolve(session, reason); return; }
    const stored = await readStoredSession();
    if (stored.exists) {
      console.log(`[layout] ${reason}: no session from auth, but one is saved — treating as offline`);
      if (appStateValueRef.current === 'loading') await enterFallback(stored.userId, 'session unconfirmed');
      return;
    }
    ++resolveGenRef.current; // a pending resolve for a previous session must not land after this
    applyResult({ state: 'unauthenticated', isCoach: false }, null, false);
  }, [runResolve, enterFallback, applyResult]);

  useEffect(() => {
    // INITIAL_SESSION fires after the Supabase client finishes reading the
    // persisted session from AsyncStorage — the earliest safe point to query.
    // getSession() can race against that read and return null even when a
    // valid session exists, causing the user to be routed to onboarding.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        try {
          if (event === 'INITIAL_SESSION') perfLog('auth resolve', sinceAppStart(), session ? 'session' : 'no session');

          // A refreshed token doesn't change routing — unless the app is running
          // offline, where it means the network is back.
          if (event === 'TOKEN_REFRESHED') {
            if (offlineModeRef.current !== null && session) void runResolve(session, 'reconnected');
            return;
          }

          // Catches every sign-out path, including the rejected-token signOut in
          // resolveAppState, so no cached athlete data survives an account switch.
          if (event === 'SIGNED_OUT') void clearUserCache();

          // For INITIAL_SESSION keep whatever is showing (the logo, or an offline
          // fallback that already fired). For every other event reset to loading
          // so the navigator unmounts cleanly before the new route is determined.
          if (event !== 'INITIAL_SESSION') { setOfflineMode(null); setAppState('loading'); }

          await handleSession(session, event);
        } catch (err) {
          console.log('[layout] auth handler error:', err);
          // Don't strand the athlete on the logo; the fallback decides between
          // the app, the offline screen, and Login.
          if (appStateValueRef.current === 'loading') await handleSession(null, 'handler error');
        }
      }
    );

    return () => subscription.unsubscribe();
  }, [runResolve, handleSession]);

  // Fallback: if nothing has resolved within FALLBACK_MS — including auth itself
  // still trying to refresh a token on a dead network — stop showing the logo.
  // A saved session gets the app (or the offline screen); no saved session gets
  // Login. The real resolution still takes over if it lands later.
  useEffect(() => {
    if (appState !== 'loading') return;
    const t = setTimeout(async () => {
      if (appStateValueRef.current !== 'loading') return;
      const stored = await readStoredSession();
      if (appStateValueRef.current !== 'loading') return;
      if (stored.exists) await enterFallback(stored.userId, `still loading after ${FALLBACK_MS}ms`);
      else applyResult({ state: 'unauthenticated', isCoach: false }, null, false);
    }, FALLBACK_MS);
    return () => clearTimeout(t);
  }, [appState, enterFallback, applyResult]);

  const retryResolve = React.useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      // getSession can itself wait on a token refresh; don't let Retry spin forever.
      const got = await Promise.race([
        supabase.auth.getSession().then(r => r.data.session),
        new Promise<'timeout'>(res => setTimeout(() => res('timeout'), 8_000)),
      ]);
      if (got === 'timeout') return;
      if (got) await runResolve(got, 'retry');
      else {
        const stored = await readStoredSession();
        if (!stored.exists) applyResult({ state: 'unauthenticated', isCoach: false }, null, false);
      }
    } finally {
      setRetrying(false);
    }
  }, [retrying, runResolve, applyResult]);

  const signOutFromOffline = React.useCallback(async () => {
    await clearUserCache();
    // 'local' removes the saved session without calling the server. The default
    // (global) sign-out returns an error offline and keeps the session, which
    // would leave this athlete "signed in" on the next launch.
    await supabase.auth.signOut({ scope: 'local' });
    // Route explicitly in case the SIGNED_OUT event doesn't arrive.
    ++resolveGenRef.current;
    applyResult({ state: 'unauthenticated', isCoach: false }, null, false);
  }, [applyResult]);

  if (appState === 'loading' || !fontsLoaded) return <BrandedLoadingScreen />;

  if (appState === 'offline') {
    return (
      <ErrorBoundary>
        <OfflineScreen retrying={retrying} onRetry={retryResolve} onSignOut={signOutFromOffline} />
      </ErrorBoundary>
    );
  }

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
    appState === 'legal'         ? 'LegalAccept' :
    appState === 'authenticated' ? 'Tabs' :
    appState === 'generating'    ? 'Generating' :
    appState === 'setup'         ? 'PinnacleSetup' :
    appState === 'waiting'       ? 'Waiting' :
                                   'Onboarding';

  return (
    <ErrorBoundary>
      <CoachContext.Provider value={isCoach}>
        <ProgramStatusContext.Provider value={{ isElite, awaitingProgram }}>
          <UnreadContext.Provider value={{ hasUnread, setHasUnread }}>
            {/* Keyed on the route so a real resolution that disagrees with the
                saved one shown offline (e.g. the legal gate) remounts into it. */}
            <NavigationContainer key={initialRoute} ref={mainNavigationRef} onReady={flushPendingTap}>
              <MainNavigator initialRoute={initialRoute} legalParams={legalParams} />
            </NavigationContainer>
            {offlineMode === 'cached' && <OfflineBanner retrying={retrying} onRetry={retryResolve} />}
          </UnreadContext.Provider>
        </ProgramStatusContext.Provider>
      </CoachContext.Provider>
    </ErrorBoundary>
  );
}
