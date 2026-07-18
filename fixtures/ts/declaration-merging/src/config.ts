// Base declaration of Config — one half of a declaration-merged interface
// (architecture §4: "checker-only type relationships (declaration merging,
// inference-only usage)").
export interface Config {
  host: string;
}

// A clean dead export, unrelated to the declaration-merging mechanism this
// case exercises: never referenced anywhere, in type position or otherwise.
// Lives alongside Config (rather than in its own unimported file) so the
// analyzer individually flags this export rather than subsuming it into a
// whole-file dead claim — the same shape as Point/UnusedShape in
// ../type-position-inverse/src/types.ts.
export function neverUsed(): string {
  return "never";
}
