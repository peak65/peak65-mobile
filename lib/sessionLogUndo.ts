import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { authHeaders } from './apiAuth';

// Undo for a session logged by mistake. The delete happens on the server
// (POST /api/session-logs/undo), which checks the 24-hour window, removes the
// heart rate screenshots from storage and deletes the row in one place. The app
// never deletes from session_logs itself; athletes have no DELETE permission.

const UNDO_URL = 'https://peak65.vercel.app/api/session-logs/undo';

// Mirrors the server's window. Only decides whether to SHOW the button; the
// server is the authority and may still refuse.
const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

// The server's own 403 wording, used only if its response carries no message,
// so both halves always say the same thing.
const WINDOW_PASSED_MESSAGE =
  'The 24-hour window to undo this session has passed. Your coach can still fix it for you.';

export function canShowUndo(loggedAt: string | number | null | undefined): boolean {
  if (loggedAt == null) return false;
  const t = typeof loggedAt === 'number' ? loggedAt : Date.parse(loggedAt);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < UNDO_WINDOW_MS;
}

export type UndoResult =
  | { kind: 'deleted' }                    // 200: row and screenshots removed
  | { kind: 'gone' }                       // 404: already removed, or not found
  | { kind: 'expired'; message: string }   // 403: window passed
  | { kind: 'failed'; message: string };   // anything else: nothing was deleted

export async function undoSessionLog(id: string): Promise<UndoResult> {
  let res: Response;
  try {
    res = await fetch(UNDO_URL, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ id }),
    });
  } catch (e) {
    console.log('[undo] network error:', e);
    return { kind: 'failed', message: "Couldn't reach Peak 65. Nothing was deleted. Check your connection and try again." };
  }

  let json: any = null;
  try { json = await res.json(); } catch {}

  if (res.status === 200 && json?.success === true) return { kind: 'deleted' };
  if (res.status === 404) return { kind: 'gone' };
  if (res.status === 403) {
    const message =
      typeof json?.message === 'string' ? json.message :
      typeof json?.error === 'string'   ? json.error :
      WINDOW_PASSED_MESSAGE;
    return { kind: 'expired', message };
  }

  console.log('[undo] failed with status', res.status);
  if (res.status === 429) {
    return { kind: 'failed', message: "Too many undo attempts. Nothing was deleted. Please try again later." };
  }
  if (res.status >= 500) {
    return { kind: 'failed', message: 'Something went wrong on our side. Nothing was deleted. Please try again.' };
  }
  return { kind: 'failed', message: "Couldn't undo this session. Nothing was deleted." };
}

// Asks before undoing. Says plainly what is deleted and that it's permanent.
export function confirmUndo(onConfirm: () => void): void {
  Alert.alert(
    'Delete this logged session?',
    'This permanently deletes the session and any heart rate screenshots attached to it. It cannot be recovered.',
    [
      { text: 'Keep it', style: 'cancel' },
      { text: 'Delete session', style: 'destructive', onPress: onConfirm },
    ],
  );
}

// Shows the outcome. Returns whether the session is gone (deleted, or already
// gone), so the caller knows whether to remove it from the screen.
export function reportUndoResult(result: UndoResult, onDismiss?: () => void): boolean {
  switch (result.kind) {
    case 'deleted':
      Alert.alert('Session deleted', 'The session and its heart rate screenshots have been removed.', [{ text: 'OK', onPress: onDismiss }]);
      return true;
    case 'gone':
      Alert.alert('Already removed', 'This session had already been removed.', [{ text: 'OK', onPress: onDismiss }]);
      return true;
    case 'expired':
      Alert.alert("Can't undo this session", result.message);
      return false;
    case 'failed':
      Alert.alert("Couldn't undo this session", result.message);
      return false;
  }
}

// Drops a removed log from the saved copies the Program and History tabs show
// first on launch, so a cold start doesn't briefly show it as completed again.
// Best-effort: each screen's next refresh replaces its cache anyway.
export async function dropLogFromCaches(id: string): Promise<void> {
  const strip = async (key: string, field: string) => {
    try {
      const raw = await AsyncStorage.getItem(key);
      if (!raw) return;
      const c = JSON.parse(raw);
      if (!Array.isArray(c?.[field])) return;
      c[field] = c[field].filter((row: any) => row?.id !== id);
      await AsyncStorage.setItem(key, JSON.stringify(c));
    } catch {}
  };
  await Promise.all([strip('program_cache', 'sessionLogs'), strip('history_cache', 'logs')]);
}
