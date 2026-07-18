// Nothing in this fixture ever imports globals.d.ts — ambient declaration files
// are never imported, they are picked up by the TS program via tsconfig "include".
export function readBuildId(): string {
  return globalThis.__UNUSED_BUILD_ID__ ?? "unknown";
}
