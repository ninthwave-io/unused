// Referenced only by scripts/build.ts, which sits OUTSIDE the config
// "project": ["src/**"] scope. Proves project narrows CLAIMABILITY, not
// DISCOVERY: scripts/build.ts must still be parsed for this import edge to
// exist, or this file would wrongly look unreferenced (the narrowing trap
// config.ts's module doc calls out as a fixed false-positive bug).
export function helperFn(): string {
  return "helper";
}
