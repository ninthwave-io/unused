// Reached ONLY from the `*.test.ts` file below. Without interim test-file
// recognition this would be a confident (high) dead export/file; as a
// test-reachable module it must be kept alive (no claim at any confidence).
export function helper(): number {
  return 42;
}
