// Only reachable via the workspaces["packages/api"].entry override.
import { chainedThing } from "./chained.js";

console.log(chainedThing());
