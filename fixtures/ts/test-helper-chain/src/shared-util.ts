// Reached from BOTH src/index.ts (production) and test/shared-trap.test.ts
// (a test) — the classic shared-helper false positive the test-only partition
// rule exists to avoid (assumption-set.md: "Code imported from BOTH
// production and a test is in the production partition ... never test-only").
export function sharedHelper(): string {
  return "shared";
}
