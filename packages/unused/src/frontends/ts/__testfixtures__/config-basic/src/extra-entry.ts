// Only reachable because unused.config.jsonc's "entry" seeds this file as an
// additional production entrypoint — nothing in src/index.ts imports it.
import { chainedThing } from "./chained.js";

console.log(chainedThing());
