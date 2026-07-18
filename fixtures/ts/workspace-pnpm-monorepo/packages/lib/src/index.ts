// The "." exports-map target (package.json "exports"). Re-exports helper by
// name rather than defining it here, so helper's own liveness is proven by a
// real re-export edge (architecture §3), not by blanket entrypoint-file
// surface liveness — the same pattern as fixtures/ts/re-export-chain.
export { helper } from "./helper.js";
