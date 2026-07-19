import { getProcessor } from "../src/handler.js";

// Imports `getProcessor` directly (mirroring hono's lambda test importing the
// processor family). This must NOT make `getProcessor` look test-only: it is
// production-alive because `handle` uses it intra-file. The test itself is a
// real test (reaches production-alive code), never a zombie.
if (getProcessor("x").run() !== 1) throw new Error("unexpected");
