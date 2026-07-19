import { livefn } from "../src/lib.js";

// Imports a production-alive symbol directly (src/index.ts also imports it).
// This test is NOT a zombie: it exercises production-alive code, so no
// test-only claim should be emitted for this test file — the uncovered
// non-zombie-test behaviour this case locks in.
if (livefn() !== "alive") throw new Error("unexpected");
