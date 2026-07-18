// Runs for its side effect when imported; nothing imports named bindings from this file.
console.log("polyfill loaded");

// Exported but never imported by anything, including src/index.ts: the side-effect
// edge that keeps this file alive does not bind this symbol.
export function unusedHelper(): number {
  return 42;
}
