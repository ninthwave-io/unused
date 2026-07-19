import { sharedHelper } from "./shared-util.js";

// The production entrypoint reaches shared-util.ts directly — the other half
// of the shared-util/shared-trap.test.ts pairing (see labels.yaml) that keeps
// shared-util.ts alive regardless of a test also reaching it.
console.log(sharedHelper());
