// Self-contained ambient declaration so this fixture does not depend on @types/node.
declare const require: (id: string) => { run: () => string };

function resolvePluginPath(): string {
  return "./plugins/core.js";
}

// require(expr): the argument is a variable, not a string literal, so static
// analysis cannot prove which module this resolves to at build time.
const dynamicPlugin = require(resolvePluginPath());
console.log(dynamicPlugin.run());

// require("literal/path"): a plain string literal argument is statically
// resolvable exactly like a static import — no hazard applies here.
const namedPlugin = require("./plugins/named.js");
console.log(namedPlugin.run());
