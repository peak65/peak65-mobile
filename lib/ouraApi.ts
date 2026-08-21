// Mobile Oura integration: signed-state fetch + authorize-URL builder.
// The backend owns ALL OAuth (code exchange + token refresh) and all data
// fetching (a cron writes daily_health_readings). The client secret never
// ships in the app.
//
// Unlike Whoop, `state` is NOT the raw user id. Mobile asks the backend to mint
// an HMAC-signed, 10-minute state token for the VERIFIED caller and passes that
// through. The backend verifies the signature before exchanging any code, so
// knowing a user id is no longer enough to bind someone else's ring to a profile.

const OURA_CLIENT_ID       = '223ae29c-b10f-4376-9919-2028fc266ca9';
const AUTH_BASE            = 'https://cloud.ouraring.com/oauth/authorize';
const BACKEND_ORIGIN       = 'https://getpeak65.com';
const BACKEND_REDIRECT_URI = `${BACKEND_ORIGIN}/api/oura/connect`;
const SCOPES               = 'personal daily heartrate';

/**
 * Ask the backend to mint a signed OAuth state for the verified caller.
 * Sends the Supabase access token; the endpoint accepts NO user id.
 */
export async function fetchOuraSignedState(accessToken: string): Promise<string> {
  const res = await fetch(`${BACKEND_ORIGIN}/api/oura/state`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`oura state request failed: ${res.status}`);
  }
  const json = await res.json();
  if (!json?.state || typeof json.state !== 'string') {
    throw new Error('oura state request returned no state');
  }
  return json.state;
}

/** Builds the Oura authorize URL around a backend-signed state token. */
export function getOuraAuthUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     OURA_CLIENT_ID,
    redirect_uri:  BACKEND_REDIRECT_URI,
    scope:         SCOPES,
    state,
  });
  return `${AUTH_BASE}?${params.toString()}`;
}
