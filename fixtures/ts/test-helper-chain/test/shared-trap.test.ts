import { sharedHelper } from "../src/shared-util.js";

// Unlike feature.test.ts, this test's reach touches src/shared-util.ts, which
// IS production-reachable (via src/index.ts) — so this test is not a zombie:
// it exercises production-alive code too, even though a test also reaches
// the same file. No test-only claim should be emitted for this test file.
if (sharedHelper() !== "shared") throw new Error("unexpected");
