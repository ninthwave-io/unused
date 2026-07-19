// Referenced ONLY by scripts/build.ts, which is OUTSIDE "project": ["src/**"].
// The importer remains in the graph but is itself unreachable, so this file is
// correctly dead. Project scope must not promote the importer to a liveness root.
export function helper(): string {
  return "helper";
}
