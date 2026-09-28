// Archived program rows. When the web portal replaces a week it keeps the old
// row with status = 'archived' and inserts a new one, so every screen and
// decision that reads `programs` must leave archived rows out. The only read
// that must NOT use this is Update Program's backup, which wants every row.

type OrFilterable<Q> = { or: (filters: string) => Q };

// Applies the archived filter to a programs query. Call it before .order() /
// .limit() so the limit counts only live weeks.
//
// NULL-safe on purpose: most legacy rows have status NULL. A plain
// .neq('status', 'archived') is `status <> 'archived'` in SQL, which is NULL —
// not true — for those rows, so it would hide every legacy week for every
// athlete. Keep the explicit `status.is.null` branch.
export function excludeArchived<Q extends OrFilterable<Q>>(query: Q): Q {
  return query.or('status.is.null,status.neq.archived');
}

export function isArchivedProgram(row: { status?: string | null } | null | undefined): boolean {
  return row?.status === 'archived';
}

type ProgramRowLike = {
  id?: string;
  week_number?: number | null;
  created_at?: string | null;
  status?: string | null;
};

function createdMs(row: ProgramRowLike): number {
  const ms = row.created_at ? Date.parse(row.created_at) : NaN;
  return Number.isNaN(ms) ? -Infinity : ms;
}

// The rows a screen should show: archived rows dropped, and at most one row per
// week number. Two live rows for one week means a replacement was left
// half-finished on the web side; keep the most recently created one and log it
// rather than guessing. Order of the input is preserved. Also used on cached
// rows, which can predate the archived filter.
export function visiblePrograms<T extends ProgramRowLike>(rows: readonly T[], context: string): T[] {
  const live = rows.filter(r => !isArchivedProgram(r));
  const chosen = new Map<number, T>();
  for (const row of live) {
    if (row.week_number == null) continue;
    const current = chosen.get(row.week_number);
    if (!current) { chosen.set(row.week_number, row); continue; }
    const newer = createdMs(row) > createdMs(current) ? row : current;
    console.warn(
      `[programs] ${context}: two live rows for week ${row.week_number} (${current.id ?? '?'}, ${row.id ?? '?'}) — using newest ${newer.id ?? '?'}`,
    );
    chosen.set(row.week_number, newer);
  }
  return live.filter(r => r.week_number == null || chosen.get(r.week_number) === r);
}
