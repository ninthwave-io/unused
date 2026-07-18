import type { Config } from "./config.js";
// Side-effect import: brings the declaration-merging augmentation into the
// module graph. Nothing is imported *by name* from this file — the entire
// value of this import is the merge it performs on Config.
import "./config-augment.js";

function describe(config: Config): string {
  return `${config.host}:${config.port}`;
}

console.log(describe({ host: "localhost", port: 8080 }));
