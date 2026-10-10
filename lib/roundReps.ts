// Per-round reps: an exercise's `round_reps` (one entry per round) lets reps vary
// across rounds. Ported from the web repo's src/lib/roundReps.ts (as of 4049c10) —
// keep the two in step; the rules must read the same on every screen. The web's
// editor-only warnings (roundRepsMismatch, extrasMismatch) are not ported.
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
//
// EXTRA SEGMENTS (drop sets): on top of its primary reps (above), a set may carry
// `extra_segments` — more work done straight on, no rest, inside that same set.
// Each is { reps, load, on }:
//   - reps: rep text, read exactly as `reps` is.
//   - load: free text for THAT segment only. The exercise's own load (its load box,
//     load / load_note / "Load:" in notes) still describes the primary work; a
//     segment's load outranks nothing and nothing reads it but this file.
//   - on: which sets carry it — 'all', 'last', or a list of set numbers (1-based).
//     Several segments on one set run in list order: 'all' covers a set that also
//     has its own.
// Wall Balls 4 x (30 @ 9 kg, then 20 @ 6 kg) is
//   { sets: 4, reps: '30', extra_segments: [{ reps: '20', load: '6 kg', on: 'all' }] }
// and a pyramid with a drop on its last set is
//   { sets: 4, reps: '12', round_reps: ['12', '10', '8', '6'],
//     extra_segments: [{ reps: '20', load: '60 kg', on: 'last' }] }.
// Only on a standalone, superset or Part exercise (extrasApply) — not in a circuit,
// EMOM, AMRAP or For Time. A set number past the set count is ignored, never
// deleted, as a long ladder is.

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
 * Extra segments follow in brackets — "12-10-8-6 (set 4 +20 @ 60 kg)", and, after
 * a caller's "4 x", "4 x 30 (each set +20 @ 6 kg)" — so every display that shows
 * reps through here shows them, on one line.
 */
export function displayReps(ex: WithRoundReps & { reps?: string | number | null; extra_segments?: unknown }): string {
  const base = ladderOrReps(ex);
  const q = extrasQualifier(ex);
  return !q ? base : base ? `${base} (${q})` : q;
}

function ladderOrReps(ex: WithRoundReps & { reps?: string | number | null }): string {
  const list = activeRoundReps(ex);
  if (list.length === 0) return ex.reps == null ? '' : String(ex.reps);
  const n = roundCount(ex);
  if (!n) return list.join('-');
  return Array.from({ length: n }, (_, r) => repsForRound(ex, r)).join('-');
}

// ─── Extra segments ──────────────────────────────────────────

export type ExtraSegment = { reps: string; load: string | null; on: 'all' | 'last' | number[] };

/** The segments as a clean list: blank reps dropped, set numbers kept positive whole numbers. */
export function extraSegmentsList(value: unknown): ExtraSegment[] {
  if (!Array.isArray(value)) return [];
  const out: ExtraSegment[] = [];
  for (const v of value) {
    if (!v || typeof v !== 'object') continue;
    const s = v as { reps?: unknown; load?: unknown; on?: unknown };
    const reps = typeof s.reps === 'number' ? String(s.reps) : typeof s.reps === 'string' ? s.reps.trim() : '';
    if (!reps) continue;
    const load = typeof s.load === 'string' && s.load.trim() !== '' ? s.load.trim() : null;
    let on: ExtraSegment['on'];
    if (s.on === undefined || s.on === null || s.on === 'all') on = 'all';
    else if (s.on === 'last') on = 'last';
    else if (Array.isArray(s.on)) {
      const nums = s.on.map(n => Number(n)).filter(n => Number.isInteger(n) && n > 0);
      if (nums.length === 0) continue;
      on = nums;
    } else continue;
    out.push({ reps, load, on });
  }
  return out;
}

/** Can extra segments apply to this exercise at all? Not inside a circuit, EMOM, AMRAP or For Time. */
export function extrasApply(ex: WithRoundReps): boolean {
  return !inRoundGroup(ex) && !ex.amrap_id;
}

/** The segments that apply to this exercise, or [] when none do. */
export function activeExtras(ex: WithRoundReps & { extra_segments?: unknown }): ExtraSegment[] {
  return extrasApply(ex) ? extraSegmentsList(ex.extra_segments) : [];
}

/** The segments set `r` (0-based) of `sets` carries, in order. */
export function extrasForSet(ex: WithRoundReps & { extra_segments?: unknown }, r: number, sets: number): ExtraSegment[] {
  return activeExtras(ex).filter(s =>
    s.on === 'all' || (s.on === 'last' ? r === sets - 1 : s.on.includes(r + 1)));
}

/**
 * The short qualifier a reps cell carries for its extras, or '' when there are none:
 * "each set +20 @ 6 kg", "set 4 +20 @ 60 kg", "sets 2, 4 +10". Segments on the same
 * sets read together; on a single set there is nothing to say which, so just "+8".
 */
export function extrasQualifier(ex: WithRoundReps & { extra_segments?: unknown }): string {
  const n = setCount(ex);
  const groups: { label: string; segs: string[] }[] = [];
  for (const s of activeExtras(ex)) {
    let label: string;
    if (s.on === 'all') label = n === 1 ? '' : 'each set';
    else if (s.on === 'last') label = n === 1 ? '' : `set ${n}`;
    else {
      const ks = s.on.filter(k => k <= n);
      if (ks.length === 0) continue;
      label = n === 1 ? '' : ks.length === 1 ? `set ${ks[0]}` : `sets ${ks.join(', ')}`;
    }
    const seg = `+${s.reps}${s.load ? ` @ ${s.load}` : ''}`;
    const g = groups.find(x => x.label === label);
    if (g) g.segs.push(seg);
    else groups.push({ label, segs: [seg] });
  }
  return groups.map(g => (g.label ? `${g.label} ${g.segs.join(' ')}` : g.segs.join(' '))).join('; ');
}
