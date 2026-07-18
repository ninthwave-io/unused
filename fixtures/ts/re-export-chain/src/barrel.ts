// Barrel: re-exports both symbols, but only one is ever consumed downstream.
export { usedThing } from "./lib/usedThing.js";
export { unusedThing } from "./lib/unusedThing.js";
