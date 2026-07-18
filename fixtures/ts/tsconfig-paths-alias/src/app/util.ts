// Resolved via the "@app/*" -> "src/app/*" alias declared in tsconfig.base.json
// (extended by tsconfig.json) — proves alias resolution follows the tsconfig
// `extends` chain rather than only the leaf tsconfig.json.
export function helper(): string {
  return "helper";
}

// Exported from the same aliased file as helper, but never imported by
// anything — the file being alive does not make every export in it alive.
export function siblingUnused(): string {
  return "sibling unused";
}
