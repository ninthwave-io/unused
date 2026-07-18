// The "browser" condition's target in package.json "exports" — never selected
// under the analyzer's condition set, yet the genuine runtime module under
// that condition.
export function run(): string {
  return "browser";
}
