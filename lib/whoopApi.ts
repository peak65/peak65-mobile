// Mobile Whoop integration is now a pure authorize-URL builder.
// The backend owns ALL OAuth (code exchange + token refresh) and all data
// fetching (a cron writes daily_health_readings). The client secret never
// ships in the app. Mobile's only job is to send the user to Whoop's authorize
// page pointed at the backend redirect.

const WHOOP_CLIENT_ID      = 'feb420a0-c020-4492-87db-44dd37c45578';
const AUTH_BASE            = 'https://api.prod.whoop.com/oauth/oauth2';
const BACKEND_REDIRECT_URI = 'https://getpeak65.com/api/whoop/connect';
// 'offline' is required so Whoop issues a refresh token the backend can use.
const SCOPES               = 'read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement offline';

// ─── Auth URL ─────────────────────────────────────────────────────────────────
// Builds the Whoop authorize URL. redirect_uri points at the backend, which
// performs the code→token exchange and stores tokens server-side. state carries
// the userId so the backend can attribute the connection to the right profile.

export function getWhoopAuthUrl(userId: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     WHOOP_CLIENT_ID,
    redirect_uri:  BACKEND_REDIRECT_URI,
    scope:         SCOPES,
    state:         userId,
  });
  return `${AUTH_BASE}/auth?${params.toString()}`;
}
