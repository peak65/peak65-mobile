// Startup timing. Evaluated when the JS bundle first imports it (from
// app/_layout.tsx), which is as close to app start as JS can see.
export const APP_START = Date.now();

// One clearly prefixed line per measurement, so real device numbers can be
// read straight out of the logs: `[perf] <label>: <ms>ms …`.
export function perfLog(label: string, ms: number, detail?: string): void {
  console.log(`[perf] ${label}: ${Math.round(ms)}ms${detail ? ` (${detail})` : ''}`);
}

export function sinceAppStart(): number {
  return Date.now() - APP_START;
}
