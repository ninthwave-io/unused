export function helper(): string {
  return "helper";
}

// Never imported by anything, aliased or relative. Proves the dangling
// "@app/missing" import elsewhere in the entry file doesn't poison liveness
// for a clean, unrelated dead export.
export function neverUsed(): string {
  return "never used";
}
