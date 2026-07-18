// Reached only through the `browser` remap the analyzer's condition set does not
// select. Without the `conditional-exports-divergence` hazard this orphan file
// would be a confident dead-file claim; with it, it is kept alive.
export function run(): string {
  return "browser";
}
