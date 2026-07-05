// Shared exercise-grouping logic for rendering a session's blocks.
// Reconstructs circuit / superset / emom / part-* groups from the per-exercise
// *_id fields. Single source of truth used by both the athlete Program view
// (app/(main)/program.tsx) and the coach athlete view (app/(main)/coach-athlete.tsx).

import type { ExerciseItem } from '../app/_layout';

export type ExGroup =
  | { kind: 'single'; ex: ExerciseItem; origIdx: number }
  | { kind: 'superset'; members: { ex: ExerciseItem; origIdx: number }[] }
  | { kind: 'circuit'; members: { ex: ExerciseItem; origIdx: number }[]; rounds: number; rest: string | null }
  | { kind: 'block'; blockName: string; members: { ex: ExerciseItem; origIdx: number }[] }
  | { kind: 'part-circuit'; blockName: string; members: { ex: ExerciseItem; origIdx: number }[]; rounds: number; rest: string | null }
  | { kind: 'part-superset'; blockName: string; members: { ex: ExerciseItem; origIdx: number }[] }
  | { kind: 'emom'; members: { ex: ExerciseItem; origIdx: number }[]; label: string | null; rounds: number | null; totalMinutes: number | null }
  | { kind: 'part-emom'; blockName: string; members: { ex: ExerciseItem; origIdx: number }[]; label: string | null; rounds: number | null; totalMinutes: number | null }
  | { kind: 'amrap'; members: { ex: ExerciseItem; origIdx: number }[]; label: string | null; timeCap: number | null }
  | { kind: 'part-amrap'; blockName: string; members: { ex: ExerciseItem; origIdx: number }[]; label: string | null; timeCap: number | null };

export function groupBySuperset(exercises: ExerciseItem[]): ExGroup[] {
  const groups: ExGroup[] = [];
  let i = 0;
  while (i < exercises.length) {
    const ex = exercises[i];
    if (ex.block_id) {
      const bId = ex.block_id;
      const blockName = ex.block_name ?? '';
      const members: { ex: ExerciseItem; origIdx: number }[] = [];
      while (i < exercises.length && exercises[i].block_id === bId) {
        members.push({ ex: exercises[i], origIdx: i });
        i++;
      }
      const firstEmomId = members[0].ex.emom_id;
      const firstAmrapId = members[0].ex.amrap_id;
      const firstCircuitId = members[0].ex.circuit_id;
      if (firstEmomId && members.every((m) => m.ex.emom_id === firstEmomId)) {
        groups.push({ kind: 'part-emom', blockName, members,
          label: members[0].ex.emom_label ?? null,
          rounds: members[0].ex.emom_rounds ?? null,
          totalMinutes: members[0].ex.emom_total_minutes ?? null });
      } else if (firstAmrapId && members.every((m) => m.ex.amrap_id === firstAmrapId)) {
        groups.push({ kind: 'part-amrap', blockName, members,
          label: members[0].ex.amrap_label ?? null,
          timeCap: members[0].ex.amrap_time_cap ?? null });
      } else if (firstCircuitId && members.every((m) => m.ex.circuit_id === firstCircuitId)) {
        groups.push({ kind: 'part-circuit', blockName, members, rounds: members[0].ex.circuit_rounds ?? 4, rest: members[0].ex.circuit_rest ?? null });
      } else {
        const firstSupersetId = members[0].ex.superset_id;
        if (firstSupersetId && members.every((m) => m.ex.superset_id === firstSupersetId)) {
          groups.push({ kind: 'part-superset', blockName, members });
        } else {
          groups.push({ kind: 'block', blockName, members });
        }
      }
    } else if (ex.emom_id) {
      const eId = ex.emom_id;
      const members: { ex: ExerciseItem; origIdx: number }[] = [];
      while (i < exercises.length && exercises[i].emom_id === eId) {
        members.push({ ex: exercises[i], origIdx: i });
        i++;
      }
      if (members.length === 1) {
        groups.push({ kind: 'single', ex: members[0].ex, origIdx: members[0].origIdx });
      } else {
        groups.push({
          kind: 'emom',
          members,
          label: members[0].ex.emom_label ?? null,
          rounds: members[0].ex.emom_rounds ?? null,
          totalMinutes: members[0].ex.emom_total_minutes ?? null,
        });
      }
    } else if (ex.amrap_id) {
      const aId = ex.amrap_id;
      const members: { ex: ExerciseItem; origIdx: number }[] = [];
      while (i < exercises.length && exercises[i].amrap_id === aId) {
        members.push({ ex: exercises[i], origIdx: i });
        i++;
      }
      if (members.length === 1) {
        groups.push({ kind: 'single', ex: members[0].ex, origIdx: members[0].origIdx });
      } else {
        groups.push({
          kind: 'amrap',
          members,
          label: members[0].ex.amrap_label ?? null,
          timeCap: members[0].ex.amrap_time_cap ?? null,
        });
      }
    } else if (ex.circuit_id) {
      const cId = ex.circuit_id;
      const members: { ex: ExerciseItem; origIdx: number }[] = [];
      while (i < exercises.length && exercises[i].circuit_id === cId) {
        members.push({ ex: exercises[i], origIdx: i });
        i++;
      }
      if (members.length === 1) {
        groups.push({ kind: 'single', ex: members[0].ex, origIdx: members[0].origIdx });
      } else {
        groups.push({
          kind: 'circuit',
          members,
          rounds: members[0].ex.circuit_rounds ?? 4,
          rest: members[0].ex.circuit_rest ?? null,
        });
      }
    } else if (ex.superset_id) {
      const ssId = ex.superset_id;
      const members: { ex: ExerciseItem; origIdx: number }[] = [];
      while (i < exercises.length && exercises[i].superset_id === ssId) {
        members.push({ ex: exercises[i], origIdx: i });
        i++;
      }
      if (members.length === 1) {
        groups.push({ kind: 'single', ex: members[0].ex, origIdx: members[0].origIdx });
      } else {
        groups.push({ kind: 'superset', members });
      }
    } else {
      groups.push({ kind: 'single', ex, origIdx: i });
      i++;
    }
  }
  return groups;
}
