// A genuine orphan. The `require` condition `./dist/cjs/index.cjs` has no `src/`
// counterpart, so it stays unresolved and raises `unresolvable-entrypoint-target`
// (whole-package medium cap). This file is therefore claimed at MEDIUM, not high:
// with the declared public API incomplete we cannot confidently prove it dead.
export function dead(): string {
  return "dead";
}
