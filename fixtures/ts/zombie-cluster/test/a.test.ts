import { buildFixture } from "../src/shared-fixture.js";

// Reaches only src/shared-fixture.ts, which is itself test-only (reached
// only by this file and test/b.test.ts) — a zombie test.
if (buildFixture() !== 7) throw new Error("unexpected");
