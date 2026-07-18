// Reached only transitively, through src/lib.ts's remapped-entrypoint import —
// proves the dist→src remap yields a real reachability root, not just a
// single marked file.
export function helperValue(): string {
  return "helper";
}
