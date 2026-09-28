// Stale-while-revalidate rules shared by the Home, Program and History caches.
//
// Cached content is shown immediately, whatever its age, and then refreshed in
// the background. Past CACHE_MAX_AGE_MS it is not shown at all: seven days is
// one full program week, so anything older has certainly missed a newly
// generated week, and every session it could offer is from a week that has
// already ended.
export const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function cacheUsable(timestamp: number | null | undefined): boolean {
  const age = Date.now() - (timestamp ?? 0);
  return age >= 0 && age < CACHE_MAX_AGE_MS;
}

// Whether a program week's dates cover today — the same local-date rule Home
// and the Program tab use to pick the active week. A cached week that no
// longer covers today would put last week's sessions on today's card, so it
// must not be shown from cache.
export function weekCoversToday(week: { week_start_date?: string | null } | null | undefined): boolean {
  if (!week?.week_start_date) return false;
  const start = new Date(week.week_start_date + 'T00:00:00');
  const end   = new Date(start.getTime() + 7 * 86_400_000);
  const now   = new Date();
  return now >= start && now < end;
}
