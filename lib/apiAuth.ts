import { supabase } from './supabase';

// The one place the app reads the signed-in athlete's token for calls to the
// Peak 65 web API. Use these helpers rather than writing another copy.
//
// A missing token is not an error. The API still accepts calls without one, so
// a call made without a session goes out with no Authorization header rather
// than failing.

// The current access token, or null when there is no session. Never throws.
export async function getAccessToken(): Promise<string | null> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  } catch {
    return null;
  }
}

// JSON request headers, with the athlete's token when there is one. `extra` is
// merged over the defaults.
export async function authHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}
