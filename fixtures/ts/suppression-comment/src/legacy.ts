// Imported by src/index.ts — keeps this FILE reachable so its two dead
// exports below are evaluated (and claimed) individually, rather than the
// whole file collapsing into a single subsuming file claim (claims.ts: an
// otherwise-unreachable file's exports are "subsumed, not separately
// claimed").
export function keepAlive(): string {
  return "keepAlive";
}

/* unused:ignore migration pending */
export function withReason(): string {
  return "withReason";
}

/* unused:ignore */
export function withoutReason(): string {
  return "withoutReason";
}
