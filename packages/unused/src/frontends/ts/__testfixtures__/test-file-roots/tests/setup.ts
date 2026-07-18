// A non-`*.test.*` file, but under a `tests/` directory at the package root ⇒ a
// `test` reachability root by the directory rule. A dead orphan otherwise; here
// it must never be claimed (it is a test root).
export function setup(): void {
  // test bootstrap
}
