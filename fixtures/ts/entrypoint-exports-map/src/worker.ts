// Reachable only via the "./worker" condition of package.json "exports" —
// nothing under the "." entry imports this file.
import { helperB } from "./shared.js";

console.log(helperB());
