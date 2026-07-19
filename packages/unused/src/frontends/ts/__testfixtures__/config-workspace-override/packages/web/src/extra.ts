// Same shape as packages/api/src/extra.ts, but this unit has NO workspace
// override — must NOT be seeded as an entrypoint, and must be flagged dead.
export function orphanInWeb(): string {
  return "orphan-in-web";
}
