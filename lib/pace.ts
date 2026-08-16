// Prescribed-pace extraction for a program session.
//
// A session's pace target lives in one of four places depending on who wrote
// the week:
//   - The AI generators write the structured `pace_target` / `pace_zone`
//     columns and leave `notes` as a plain coaching cue.
//   - The coach editor writes the structured `pace` column AND packs the same
//     value into `notes` as "Pace: X | Load: Y | cue" (its serializeNotes).
//   - Older / hand-touched rows may carry only that packed `notes` form.
// The precedence below is ported from the web codebase's printableProgram.ts
// resolvePace, so the phone and the printable program never disagree about
// what was prescribed.
//
// Read-only: nothing here mutates a session or touches the database. Not wired
// into any screen — this is the read foundation for the "did you hit your
// target?" capture flow.

import type { ExerciseItem, ProgramSession, SessionBlock } from '../app/_layout';

export type PaceTarget = {
  // The prescribed pace/split as written, e.g. "4:45 /km", "6:30/Mi", "zone4".
  // Null when the session carries no pace target at all.
  value: string | null;
  // True only when the sole source was `pace_zone` — an effort band ("zone4"),
  // not a number the athlete can hit. Callers that want to show or compare a
  // split must branch on this rather than treating `value` as a pace.
  isZoneOnly: boolean;
};

// Matches the coach editor's packed-notes format. Same expression as the web
// parseNotes so both sides split a packed note identically.
const PACKED_PACE = /Pace:\s*([^|]+?)(?=\s*\||$)/;

// A usable string, or null. Guards against the empty strings and non-strings
// that real program JSON contains (the editor writes '' before it writes null).
function clean(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// The prescribed pace for a single exercise, in web resolvePace precedence:
// pace_target → pace → pace_zone → the value packed into notes.
export function resolveExercisePace(ex: ExerciseItem): PaceTarget {
  const target = clean(ex.pace_target);
  if (target) return { value: target, isZoneOnly: false };

  const pace = clean(ex.pace);
  if (pace) return { value: pace, isZoneOnly: false };

  // Zone label only — a band, not a target. Flagged so callers can degrade to
  // "did you hold Zone 4?" instead of asking for a split.
  const zone = clean(ex.pace_zone);
  if (zone) return { value: zone, isZoneOnly: true };

  const notes = clean(ex.notes) ?? clean(ex.note);
  if (notes) {
    const match = notes.match(PACKED_PACE);
    const packed = match ? clean(match[1]) : null;
    if (packed) return { value: packed, isZoneOnly: false };
  }

  return { value: null, isZoneOnly: false };
}

// The session's main work block: the one flagged is_work, falling back to a
// block named "Main …" for assessment weeks and older programs that predate the
// flag. Returns null when neither identifies a block — we never guess, since a
// warm-up or cool-down pace is not the session's prescription.
function findWorkBlock(session: ProgramSession): SessionBlock | null {
  const blocks = session.blocks ?? [];
  return (
    blocks.find((b) => b?.is_work === true) ??
    blocks.find((b) => /main/i.test(b?.block_name ?? '')) ??
    null
  );
}

// The prescribed pace for a session's main work — the first exercise in the
// work block that carries one. Null value means "this session has no pace
// target", which is the signal the capture flow will trigger on.
export function getSessionPaceTarget(session: ProgramSession): PaceTarget {
  const workBlock = findWorkBlock(session);
  if (!workBlock) return { value: null, isZoneOnly: false };

  for (const ex of workBlock.exercises ?? []) {
    const resolved = resolveExercisePace(ex);
    if (resolved.value !== null) return resolved;
  }

  return { value: null, isZoneOnly: false };
}
