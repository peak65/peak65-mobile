import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SUPABASE_URL = 'https://hgcfgywyrtgqmyzhxioc.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhnY2ZneXd5cnRncW15emh4aW9jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5OTE0NzQsImV4cCI6MjA5MjU2NzQ3NH0.51SQRYZVu-vRTmHbaxCOM1vTezbtceCBOTc_vdujtko';

/*
  Run these in the Supabase SQL editor:

  alter table public.profiles add column if not exists body_fat_range text;
  alter table public.profiles add column if not exists weekly_mileage text;
  alter table public.profiles add column if not exists fitness_goal text;

  create table if not exists public.checkins (
    id uuid default gen_random_uuid() primary key,
    user_id uuid references auth.users(id) on delete cascade,
    created_at timestamp with time zone default now(),
    weight numeric,
    weight_unit text,
    body_fat_percentage numeric
  );

  create table if not exists public.programs (
    id uuid default gen_random_uuid() primary key,
    user_id uuid references auth.users(id) on delete cascade,
    created_at timestamp with time zone default now(),
    week_start_date date,
    days jsonb
  );

  create table if not exists public.session_logs (
    id uuid default gen_random_uuid() primary key,
    user_id uuid references auth.users(id) on delete cascade,
    program_id uuid references public.programs(id),
    day_index integer,
    rpe integer,
    duration integer,
    notes text,
    completed_at timestamp with time zone default now()
  );
*/

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
