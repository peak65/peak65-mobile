// A day's sessions are ordered, and labelled, by POSITION: "Session 1", "Session 2",
// "Session 3". Two sessions a day is normal, three occasional, never more.
// Ported from the web repo's src/lib/sessionOrder.ts — keep the two in step.
//
// The stored `time` ('AM' / 'PM') is kept, never removed and never anything but
// those strings: the first session in a day is 'AM', every one after it 'PM'
// (slotTime). Older phone builds sort and label by it, and a logged session
// (session_logs.session_time) is matched to its session by name + that value, so
// changing what is stored would orphan an athlete's history.
//
// Order and labels are DISPLAY ONLY. Nothing here takes part in matching a log
// to its session.
//
// orderSessions is the one ordering every reader uses: a stable AM-first sort.
// For a day the editor has saved (AM first, PMs after) it is exactly the stored
// order; it only reorders a day stored PM-before-AM — which every reader has
// always displayed AM-first — so nothing visibly moves.

/** Usual most sessions in a day. More is allowed, with a warning in the editor. */
export const MAX_SESSIONS_PER_DAY = 3;

/**
 * A day's sessions in display order: stable, AM-first. A new array; the input is
 * untouched. The original index breaks ties, so the order is the web's (V8's
 * stable sort) whatever the JS engine does with equal keys — two PM sessions
 * keep their stored order.
 */
export function orderSessions<T>(sessions: readonly T[] | null | undefined): T[] {
  const isPM = (s: T) => ((s as { time?: unknown } | null)?.time === 'PM' ? 1 : 0);
  return (sessions ?? [])
    .map((s, i) => ({ s, i }))
    .sort((a, b) => isPM(a.s) - isPM(b.s) || a.i - b.i)
    .map(x => x.s);
}

/** "Session 1" for position 0. */
export function sessionLabel(index: number): string {
  return `Session ${index + 1}`;
}

/** The stored `time` for a position: 'AM' first, 'PM' after. */
export function slotTime(index: number): 'AM' | 'PM' {
  return index === 0 ? 'AM' : 'PM';
}
