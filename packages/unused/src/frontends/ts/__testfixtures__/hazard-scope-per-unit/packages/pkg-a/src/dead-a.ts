// Dead code inside pkg-a: correctly capped to medium by pkg-a's own whole-package
// computed-require hazard (it could be that require's runtime target).
export function deadA(): number {
  return 1;
}
