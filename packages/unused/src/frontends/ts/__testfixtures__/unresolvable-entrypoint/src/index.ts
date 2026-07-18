// The public entry. On disk there is no `dist/` (unbuilt clone), so the declared
// `./dist/index.js` target is recovered by the dist→src remap and this file
// becomes a production entrypoint. Its transitive imports stay alive.
import { core } from "./core.js";

export function main(): string {
  return core();
}
