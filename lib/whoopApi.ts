// Mobile Whoop integration: signed-state fetch + authorize-URL builder.
// The backend owns ALL OAuth (code exchange + token refresh) and all data
// fetching (a cron writes daily_health_readings). The client secret never
// ships in the app.
//
// `state` is NOT the raw user id. Mobile asks the backend to mint a signed
// state token for the VERIFIED caller and passes that through; the backend
// rejects a raw user id at the callback. Same flow as lib/ouraApi.ts.

const WHOOP_CLIENT_ID      = 'feb420a0-c020-4492-87db-44dd37c45578';
const AUTH_BASE            = 'https://api.prod.whoop.com/oauth/oauth2';
const BACKEND_ORIGIN       = 'https://getpeak65.com';
const BACKEND_REDIRECT_URI = `${BACKEND_ORIGIN}/api/whoop/connect`;
// 'offline' is required so Whoop issues a refresh token the backend can use.
const SCOPES               = 'read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement offline';

/**
 * Ask the backend to mint a signed OAuth state for the verified caller.
 * Sends the Supabase access token; the endpoint accepts NO user id.
 */
export async function fetchWhoopSignedState(accessToken: string): Promise<string> {
  const res = await fetch(`${BACKEND_ORIGIN}/api/whoop/state`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`whoop state request failed: ${res.status}`);
  }
  const json = await res.json();
  if (!json?.state || typeof json.state !== 'string') {
    throw new Error('whoop state request returned no state');
  }
  return json.state;
}

// ─── Auth URL ─────────────────────────────────────────────────────────────────
// Builds the Whoop authorize URL around a backend-signed state token.
// redirect_uri points at the backend, which verifies the state, performs the
// code→token exchange and stores tokens server-side.

export function getWhoopAuthUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     WHOOP_CLIENT_ID,
    redirect_uri:  BACKEND_REDIRECT_URI,
    scope:         SCOPES,
    state,
  });
  return `${AUTH_BASE}/auth?${params.toString()}`;
}
