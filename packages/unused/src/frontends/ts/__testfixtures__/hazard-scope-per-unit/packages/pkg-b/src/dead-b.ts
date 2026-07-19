// Dead code inside pkg-b: pkg-b has no hazard of its own, and pkg-a's computed
// require is a DIFFERENT package — so this must stay a HIGH-confidence claim.
// Before the per-unit scoping fix, pkg-a's empty-prefix cap leaked across the
// shared graph and wrongly downgraded this to medium.
export function deadB(): number {
  return 3;
}
