import { ping } from "./util.js";

// The production entrypoint never imports src/shared-fixture.ts — that file
// is reached only from the two test files (see labels.yaml).
console.log(ping());
