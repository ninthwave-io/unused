// Fooling input (axios `examples/server.js` shape): a computed dynamic import
// whose left literal is a URL SCHEME, not a path prefix —
// `import('file://' + path.join(...))`. `staticSpecifierPrefix` must NOT treat
// `"file://"` as a directory prefix (it matches zero repo-relative paths and
// would leave `mod.ts` a HIGH-confidence claim); a non-relative prefix collapses
// to whole-package scope, so `mod.ts` is capped medium instead.
import { join } from "node:path";

async function load(name: string): Promise<{ run: () => string }> {
  return import("file://" + join("base", `${name}.js`));
}

load("mod").then((m) => console.log(m.run()));
