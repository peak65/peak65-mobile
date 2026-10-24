// Parsing and display helpers for a single exercise's prescription, shared by
// the athlete Program view and the coach athlete view so both read the same
// data the same way.

import type { ExerciseItem } from '../app/_layout';

export type ExerciseNotes = {
  pace: string | null;   // value only, label stripped: "6:30/mi"
  load: string | null;   // value only, label stripped: "RPE 8", "60kg"
  cue: string | null;    // everything not labelled
};

const PACE_LABEL = /^pace:\s*/i;
const LOAD_LABEL = /^load:\s*/i;

// Splits a note the coach editor packed as "Pace: X | Load: Y | cue". Segment
// order doesn't matter and any part may be missing; a note with no labels is
// all cue.
export function parseExerciseNotes(raw: string | null | undefined): ExerciseNotes {
  let pace: string | null = null;
  let load: string | null = null;
  const cue: string[] = [];

  for (const segment of (raw ?? '').split('|').map(s => s.trim())) {
    if (!segment) continue;
    if (PACE_LABEL.test(segment)) {
      pace = segment.replace(PACE_LABEL, '').trim() || null;
    } else if (LOAD_LABEL.test(segment)) {
      load = segment.replace(LOAD_LABEL, '').trim() || null;
    } else {
      cue.push(segment);
    }
  }

  return { pace, load, cue: cue.length > 0 ? cue.join(' · ') : null };
}

// Rest between sets, as every display prints it. Mirrors the web repo's
// src/lib/rest.ts (as of 04f6fb0) — keep the two identical. Two fields each:
//   rest / circuit_rest            HOW LONG — "60 sec", "3 min".
//   rest_note / circuit_rest_note  WHAT — optional: "standing", "float @ 110-130W".
// Printed everywhere as "rest 60 sec standing" — prefix, never suffix, the coach's
// own words, nothing added or guessed. A rest written before the split is all in
// HOW LONG ("60 Second Rest") and prints as "rest 60 Second Rest" until edited.
//
// A rest ROW (type 'rest', "REST — 2 min") is a break between Parts, not an
// exercise's rest: it prints through restLabel below, and restText returns null
// for one.

export type RestFields = {
  type?: string | null;
  rest?: string | null;
  rest_note?: string | null;
  circuit_rest?: string | null;
  circuit_rest_note?: string | null;
};

// Stored values that mean "no rest". Real rows carry "none" and "null" as TEXT.
const NO_REST = ['none', 'null', '0', '0 min', '0:00', '00:00'];

// A stored value that isn't a string (a numeric 60) counts as nothing.
function clean(v: string | null | undefined): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
}

/** HOW LONG worth showing, or null when there is effectively none. */
export function restValue(v: string | null | undefined): string | null {
  const s = clean(v);
  return s && !NO_REST.includes(s.toLowerCase()) ? s : null;
}

/** "rest 60 sec standing" / "rest 90 sec" / null. WHAT alone still prints: "rest standing". */
export function formatRest(howLong: string | null | undefined, what: string | null | undefined): string | null {
  const parts = [restValue(howLong), clean(what)].filter((p): p is string => !!p);
  return parts.length ? `rest ${parts.join(' ')}` : null;
}

/** An exercise's rest between sets. null for a rest row, or when there is none. */
export function restText(ex: RestFields): string | null {
  if (ex.type === 'rest') return null;
  return formatRest(ex.rest, ex.rest_note);
}

/** A circuit's rest between rounds, read from its first member: "rest 90 sec between rounds". */
export function circuitRestText(first: RestFields): string | null {
  const r = formatRest(first.circuit_rest, first.circuit_rest_note);
  return r ? `${r} between rounds` : null;
}

// Rest rows written by the web editor: a break between movements, not a movement.
export function isRestRow(ex: { type?: string | null }): boolean {
  return ex.type === 'rest';
}

// "REST — 3 min" for a rest row. Length lives in `duration`, mirrored in `reps`,
// and is shown exactly as the coach typed it.
export function restLabel(ex: Pick<ExerciseItem, 'duration' | 'reps'>): string {
  const length = (ex.duration ?? '').trim() || (ex.reps ?? '').trim();
  return length ? `REST — ${length}` : 'REST';
}
