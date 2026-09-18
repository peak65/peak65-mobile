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

// ─── Multi-piece pace targets ────────────────────────────────────────────────
//
// getSessionPaceTarget above answers "what is THE pace for this session?" and
// stops at the first one it finds. That is wrong for a session built from
// several paced pieces — a threshold day with a Ski Erg at 2:08/500m and a Row
// Erg at 2:15/500m has two prescriptions, and the athlete's answer for the
// second was being dropped on the floor. getSessionPaceTargets returns all of
// them, in prescription order, so the capture flow can ask about each.
//
// The scalar function is left untouched: it still backs the rollup columns that
// the coach portal and weekly generation read.

export type PaceTargetItem = {
  // Stable identifier, safe as an object key. Positional — "<blockIndex>-<exerciseIndex>"
  // against the ORIGINAL session.blocks array, so it survives re-renders of the
  // same session without colliding across blocks.
  key: string;
  // Exercise name as shown to the athlete. Never empty — falls back to 'Target'.
  name: string;
  // The resolved pace string. Non-null by construction; an exercise with no
  // pace never becomes an item.
  value: string;
  // Same meaning as PaceTarget.isZoneOnly — an effort band, not a split.
  isZoneOnly: boolean;
};

// Asking about more than a handful of pieces stops being a log and starts being
// a form. Programs this long are malformed rather than legitimately paced.
const MAX_PACE_TARGETS = 6;

// Same test findWorkBlock applies, factored out so both agree about what counts
// as work. findWorkBlock keeps taking only the FIRST match; this is used to take
// every match, since a session's paced pieces can live in separate blocks.
function isWorkBlock(block: SessionBlock | undefined | null): boolean {
  if (!block) return false;
  return block.is_work === true || /main/i.test(block.block_name ?? '');
}

// Every prescribed pace across the session's work blocks, in the order they are
// written. Empty means the session carries no pace target at all, which is the
// signal the capture flow gates on.
export function getSessionPaceTargets(session: ProgramSession): PaceTargetItem[] {
  const blocks = session.blocks ?? [];
  const items: PaceTargetItem[] = [];
  // name+value pairs already collected. A circuit that repeats the same erg at
  // the same split is one question, not three.
  const seen = new Set<string>();

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex];
    if (!isWorkBlock(block)) continue;

    const exercises = block?.exercises ?? [];
    for (let exerciseIndex = 0; exerciseIndex < exercises.length; exerciseIndex++) {
      const ex = exercises[exerciseIndex];
      if (!ex) continue;

      const resolved = resolveExercisePace(ex);
      if (resolved.value === null) continue;

      // clean() rejects the empty strings and non-strings real program JSON
      // carries, so an unnamed exercise gets a usable label rather than a blank.
      const name = clean(ex.name) ?? 'Target';

      const dedupeKey = `${name.toLowerCase()}|${resolved.value}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      items.push({
        key:        `${blockIndex}-${exerciseIndex}`,
        name,
        value:      resolved.value,
        isZoneOnly: resolved.isZoneOnly,
      });

      if (items.length === MAX_PACE_TARGETS) return items;
    }
  }

  return items;
}
