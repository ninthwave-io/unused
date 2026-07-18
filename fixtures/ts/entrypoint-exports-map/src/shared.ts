export function helperA(): string {
  return "a";
}

export function helperB(): string {
  return "b";
}

// Not reachable from either declared "exports" entry.
export function helperC(): string {
  return "c";
}
