// No package.json main/module/exports/bin, and no index.* fallback file exists,
// so this project has ZERO production entrypoints. Nothing anchors liveness —
// the analyzer must claim NOTHING (never flag the whole codebase).
export function thing(): string {
  return "thing";
}
