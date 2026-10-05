import { weekCoversToday } from './cachePolicy';

// Which program week to show. One copy of the rule, used by Home and the
// Program tab. Weeks are expected in ascending week_number order, as both
// screens query them; "newest" is the last one.

type Week = { week_start_date?: string | null };

// Local midnight on the week's start date, or null if it has none.
function startOf(week: Week): Date | null {
  if (!week.week_start_date) return null;
  const d = new Date(week.week_start_date + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? null : d;
}

// The week whose seven days include today, or null.
export function weekCoveringToday<T extends Week>(weeks: readonly T[]): T | null {
  return weeks.find(w => weekCoversToday(w)) ?? null;
}

// Whether the week's start date has arrived. A week with no start date counts
// as started, so nothing asks about a week it can't date.
export function weekHasStarted(week: Week): boolean {
  const start = startOf(week);
  return start === null || new Date() >= start;
}

// The week the Program tab opens on: the one covering today; otherwise the
// latest week that has already started; only when none has started, the newest.
// Never a week that hasn't begun while one that has is available.
export function weekToOpen<T extends Week>(weeks: readonly T[]): T | null {
  const covering = weekCoveringToday(weeks);
  if (covering) return covering;
  for (let i = weeks.length - 1; i >= 0; i--) {
    if (startOf(weeks[i]) !== null && weekHasStarted(weeks[i])) return weeks[i];
  }
  return weeks[weeks.length - 1] ?? null;
}

// "Monday, Oct 6" — for naming a week's start date to the athlete.
export function formatWeekStart(week: Week): string | null {
  const start = startOf(week);
  return start ? start.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) : null;
}
