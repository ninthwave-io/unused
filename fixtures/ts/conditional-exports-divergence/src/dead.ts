// A genuine orphan, unrelated to the exports-map divergence: not named by any
// exports condition, not imported by anything.
export function neverCalled(): void {
  // noop
}
