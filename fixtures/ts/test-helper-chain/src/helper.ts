import { prodModuleFn } from "./prod-module.js";

// A test-side helper: never imported by src/index.ts, only by
// test/feature.test.ts. It forwards into src/prod-module.ts, which — despite
// living under src/ and looking like production code — is reached ONLY
// through this chain.
export function chainHelper(): number {
  return prodModuleFn();
}
