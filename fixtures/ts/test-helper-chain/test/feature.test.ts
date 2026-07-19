import { chainHelper } from "../src/helper.js";

// This test's entire reach is src/helper.ts -> src/prod-module.ts, both
// test-only — it exercises no production-alive code, so it is a zombie test
// (T5.2 point 3), even though it imports a real chain two files deep.
if (chainHelper() !== 42) throw new Error("unexpected");
