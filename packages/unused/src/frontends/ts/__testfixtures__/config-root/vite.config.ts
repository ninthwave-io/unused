// A config root (`*.config.ts` at a package root): never claimed, and a
// reachability seed — the helper it imports must stay alive.
import { buildOptions } from "./src/build.js";

export default {
  build: buildOptions(),
};
