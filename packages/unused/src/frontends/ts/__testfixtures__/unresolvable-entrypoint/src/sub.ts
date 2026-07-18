// A second subpath entry (`./sub` → `./dist/sub.js`), recovered by the remap.
// Without the remap this whole subpath's public API would be flagged dead.
export function sub(): string {
  return "sub";
}
