import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SUPABASE_URL = 'https://hgcfgywyrtgqmyzhxioc.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhnY2ZneXd5cnRncW15emh4aW9jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5OTE0NzQsImV4cCI6MjA5MjU2NzQ3NH0.51SQRYZVu-vRTmHbaxCOM1vTezbtceCBOTc_vdujtko';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
