// A genuine orphan: no CDK bin entry references it and no file imports it. The
// CDK preset must NOT keep it alive; flagged dead at high confidence because no
// hazard is in scope.
export function orphan(): number {
  return 42;
}
