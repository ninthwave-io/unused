// A genuine orphan: not an entrypoint, not reached from production OR a test.
// Interim test recognition must not blanket the repo — this still flags high.
export function dead(): string {
  return "dead";
}
