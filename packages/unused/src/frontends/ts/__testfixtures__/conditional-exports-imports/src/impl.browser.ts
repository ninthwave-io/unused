// Reached only through the `#impl` imports-map `browser` condition, which the
// analyzer's condition set does not select (it resolves `#impl` via `default`).
// Without folding `imports` into conditional-exports-divergence this live module
// would be a HIGH-confidence dead-file claim.
export function run(): string {
  return "browser";
}
