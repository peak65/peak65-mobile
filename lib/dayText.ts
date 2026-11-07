// A day's own title and note, written by the coach on the web (src/lib/programEditorShape.ts
// stores them; src/app/api/coach/program-pdf/route.ts reads them). Both are optional
// plain strings on the day object: the title is one line, the note is one or more
// paragraphs joined with "\n". Most stored days have neither.
//
// Every screen reads them through this file and nothing else. The data arrives as
// cast, unchecked JSON, so a value is used only when it is a string that trims to
// something; anything else (a number, an object, null, a blank string) is treated as
// absent rather than trusted. A rest value that wasn't text once crashed the Program
// screen on .trim() - this is the guard against that.

export type DayTextSource = {
  type?: string | null;
  sessions?: readonly unknown[] | null;
  title?: unknown;
  note?: unknown;
};

// The web's guard, exactly (program-pdf/route.ts dayText).
export const dayText = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** The day's title, trimmed, or null. */
export function dayTitle(day: DayTextSource | null | undefined): string | null {
  return dayText(day?.title);
}

/** The note's paragraphs: one per line, each trimmed, blank ones dropped. [] when none. */
export function dayNoteParagraphs(day: DayTextSource | null | undefined): string[] {
  const note = dayText(day?.note);
  if (note == null) return [];
  return note.replace(/\r\n?/g, '\n').split('\n').map(p => p.trim()).filter(p => p !== '');
}

/** True when the day has a title or a note to show. */
export function hasDayText(day: DayTextSource | null | undefined): boolean {
  return dayTitle(day) != null || dayNoteParagraphs(day).length > 0;
}

// A race day with nothing programmed is the race itself. Without a title or note it
// would render as an empty card, which reads as a mistake, so it says "Race day".
export const RACE_DAY_LINE = 'Race day';

/** A race day with no sessions, no title and no note. */
export function showsRaceDayLine(day: DayTextSource | null | undefined): boolean {
  return day?.type === 'race' && !(day.sessions?.length) && !hasDayText(day);
}

/**
 * The one-line label the coach view shows for a day with no sessions, in place of
 * "—": the day's title, or "Race day" for a race day without one. A race's note never
 * fits on that line, so a race day with only a note still reads "Race day".
 */
export function dayListLabel(day: DayTextSource | null | undefined): string {
  return dayTitle(day) ?? (day?.type === 'race' ? RACE_DAY_LINE : '—');
}
