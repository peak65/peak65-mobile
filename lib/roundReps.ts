// Per-round reps: an exercise's `round_reps` (one entry per round) lets reps vary
// across rounds. Ported from the web repo's src/lib/roundReps.ts — keep the two
// in step; the rules must read the same on every screen.
//
// The "rounds" are:
//   - in a circuit: the circuit's rounds (circuit_rounds; a missing count is 4).
//     Wall Balls 30 / 40 / 50 across 3 rounds is
//     { reps: '30', round_reps: ['30', '40', '50'] }.
//   - in an EMOM: the EMOM's rounds (emom_rounds).
//   - in a For Time: its rounds (for_time_rounds) — 40 / 30 / 20 / 10 over 4.
//   - anywhere else — a standalone exercise, a superset member, an exercise in a
//     Part — its OWN sets, when sets > 1: a 12 / 10 / 8 / 6 pyramid is
//     { sets: 4, reps: '12', round_reps: ['12', '10', '8', '6'] }.
//   - never in an AMRAP: it has no fixed rounds.
//
// The rules:
//   - Absent or empty: reps are constant every round, exactly as before.
//   - Only meaningful where it APPLIES (roundRepsApply): in a circuit or EMOM, or
//     on any other non-AMRAP exercise with sets > 1. Anywhere else it is ignored.
//   - Round N uses entry N. A list SHORTER than the round count: the rounds it does
//     not cover use the exercise's `reps`. LONGER: the extra entries are ignored.
//   - Entries are rep text, read exactly as `reps` is ("30", "12 Cal").

type WithRoundReps = {
  round_reps?: unknown;
  sets?: unknown;
  circuit_id?: string | null;
  circuit_rounds?: number | null;
  emom_id?: string | null;
  emom_rounds?: number | null;
  amrap_id?: string | null;
  for_time_id?: string | null;
  for_time_rounds?: number | null;
};

/** The entries as a clean list, from the stored array or the editor's "30-40-50" text. */
export function roundRepsList(value: unknown): string[] {
  const parts = Array.isArray(value)
    ? value.map(v => (typeof v === 'number' ? String(v) : typeof v === 'string' ? v : ''))
    : typeof value === 'string'
      ? value.split(/\s*[-–/,]\s*/)
      : [];
  return parts.map(p => p.trim()).filter(p => p !== '');
}

/** Is this exercise in a group whose rounds the list applies to? */
export function inRoundGroup(ex: WithRoundReps): boolean {
  return !!ex.circuit_id || !!ex.emom_id || !!ex.for_time_id;
}

/** The exercise's own set count (stored as a number, typed in the editor as text). */
export function setCount(ex: WithRoundReps): number {
  return parseInt(String(ex.sets ?? '')) || 1;
}

/** Can a per-round ladder apply to this exercise at all? */
export function roundRepsApply(ex: WithRoundReps): boolean {
  if (inRoundGroup(ex)) return true;
  if (ex.amrap_id) return false;
  return setCount(ex) > 1;
}

/** How many rounds the list is measured against, or null when unknown (an EMOM with no count). */
export function roundCount(ex: WithRoundReps): number | null {
  if (ex.circuit_id) return ex.circuit_rounds ?? 4;
  if (ex.emom_id) return ex.emom_rounds && ex.emom_rounds > 0 ? ex.emom_rounds : null;
  if (ex.for_time_id) return ex.for_time_rounds && ex.for_time_rounds > 0 ? ex.for_time_rounds : null;
  return roundRepsApply(ex) ? setCount(ex) : null;
}

/** The ladder that applies to this exercise, or [] when none does. */
export function activeRoundReps(ex: WithRoundReps): string[] {
  return roundRepsApply(ex) ? roundRepsList(ex.round_reps) : [];
}

/** Reps for round `r` (0-based): the list's entry, else the exercise's reps. */
export function repsForRound(ex: WithRoundReps & { reps?: string | number | null }, r: number): string {
  const list = activeRoundReps(ex);
  return r < list.length ? list[r] : (ex.reps == null ? '' : String(ex.reps));
}

/**
 * How a reps cell reads. With a ladder: the reps actually done in each round,
 * joined — "12-10-8-6" — one entry per round, so a list shorter than the round
 * count shows the base reps filling in and a longer one is cut to what is done.
 * No "4 x" in front: the entry count already is the set count, and "4 x 12-10-8-6"
 * would read as four sets of each. Without a ladder: the reps as written.
 */
export function displayReps(ex: WithRoundReps & { reps?: string | number | null }): string {
  const list = activeRoundReps(ex);
  if (list.length === 0) return ex.reps == null ? '' : String(ex.reps);
  const n = roundCount(ex);
  if (!n) return list.join('-');
  return Array.from({ length: n }, (_, r) => repsForRound(ex, r)).join('-');
}
