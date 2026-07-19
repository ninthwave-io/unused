// Referenced ONLY by scripts/build.ts, which is OUTSIDE "project": ["src/**"].
// Before the reviewer fix, an out-of-project file was dropped from the graph
// entirely (never parsed), so this import edge never existed and helper.ts
// false-flagged as a confident high-confidence "unused" — a real FP on live
// code. It must NOT be claimed.
export function helper(): string {
  return "helper";
}
