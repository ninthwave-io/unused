// Referenced only by scripts/build.ts, which sits OUTSIDE the config
// "project": ["src/**"] scope. Project narrows CLAIMABILITY, not DISCOVERY:
// scripts/build.ts is still parsed and its edge retained, but an edge from an
// unreachable importer does not make this file live (ADR 0012).
export function helperFn(): string {
  return "helper";
}
