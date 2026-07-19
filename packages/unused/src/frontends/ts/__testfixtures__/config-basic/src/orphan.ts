// A genuine orphan, in scope (matches "project": ["src/**/*.ts"], not
// matched by "ignore") — must still be flagged.
export function orphan(): string {
  return "orphan";
}
