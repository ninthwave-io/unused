import { helperValue } from "./helper.js";

// Reachable via package.json "main" ("dist/lib.js"): this unbuilt checkout has
// no dist/ directory, so the target is remapped to this file (the T3.6
// dist/**→src/** heuristic).
export function run(): string {
  return helperValue();
}
