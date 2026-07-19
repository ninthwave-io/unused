// No story renders it and no file imports it — a genuine orphan the aggregator
// must not keep alive. Dead at high confidence (no hazard in scope).
export function Orphan(): null {
  return null;
}
