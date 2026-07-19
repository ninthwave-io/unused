import { testFn } from "test-dep";

// The only reference to "test-dep" anywhere in this fixture — no production
// or config file imports it.
if (testFn() !== "ok") throw new Error("unexpected");
