// Reached only from test/feature.test.ts — a file under a root-level `test/`
// directory, one of the zero-config test-root conventions (assumption-set.md
// "Test files are reachability roots (interim, ahead of M5)"). No production
// file imports this.
export function computeFeature(x: number): number {
  return x * 2;
}
