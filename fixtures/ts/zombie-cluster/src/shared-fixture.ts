// Reached only from test/a.test.ts and test/b.test.ts — never from
// src/index.ts or any config root. A mutual test-only cluster: two
// independent test files both exercise this one module and nothing else.
export function buildFixture(): number {
  return 7;
}
