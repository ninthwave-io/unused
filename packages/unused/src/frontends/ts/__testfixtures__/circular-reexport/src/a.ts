// Circular star chain: a re-exports b, b re-exports a. Emit must terminate
// (it emits one file-level edge per file; it never traverses the cycle).
export * from "./b.js";

export function fromA(): string {
  return "a";
}
