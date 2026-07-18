export function ping(): string {
  return "pong";
}

// A clean dead export in a stand-alone project — but this project's tsconfig
// has a `references` array, so the whole package is capped at medium (a
// sibling project may consume this file across the project boundary; the
// single-project reference graph cannot see it).
export function deadButMaybeConsumed(): number {
  return 2;
}
