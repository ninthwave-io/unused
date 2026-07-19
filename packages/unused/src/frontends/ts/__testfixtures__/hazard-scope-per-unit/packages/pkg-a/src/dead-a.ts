// Dead code inside pkg-a. The package's computed-require carrier is itself
// unreachable, so this remains a high-confidence claim.
export function deadA(): number {
  return 1;
}
