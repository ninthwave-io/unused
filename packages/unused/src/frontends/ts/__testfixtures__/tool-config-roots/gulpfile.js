// A tool-invoked config root (loaded by the `gulp` CLI by filename convention,
// never imported). It must never be claimed, and it seeds its import as a live
// edge — `src/tasks.ts` stays alive through it.
import { build } from "./src/tasks.js";

export default build;
