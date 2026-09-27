import * as Notifications from 'expo-notifications';
import { supabase } from './supabase';

// Sets the app icon badge to the user's real unread message count. Counts both
// directions — threads where the user is the athlete and threads where they are
// the coach — so a coach who reads one athlete's thread keeps a badge for the
// others. Never throws: a badge that is briefly wrong is harmless, an error
// surfaced from it is not.
export async function syncBadge(userId: string): Promise<void> {
  try {
    const { count, error } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .is('read_at', null)
      .neq('sender_id', userId)
      .or(`athlete_id.eq.${userId},coach_id.eq.${userId}`);
    if (error) {
      console.log('[syncBadge] count failed:', error.message);
      return;
    }
    await Notifications.setBadgeCountAsync(count ?? 0);
  } catch (err) {
    console.log('[syncBadge] error:', err);
  }
}
