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

const NO_REST = ['none', '0', '0 min', '0:00', '00:00'];

// The rest value worth showing, or null when there is effectively none.
export function displayRest(rest: string | null | undefined): string | null {
  const trimmed = (rest ?? '').trim();
  if (!trimmed || NO_REST.includes(trimmed.toLowerCase())) return null;
  return trimmed;
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
