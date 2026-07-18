// Both imports below are TSImportEqualsDeclarations, TS's spelling for CJS
// interop (`import x = require("mod")`), not standard ES imports. Both
// targets are literal string module specifiers — statically resolvable,
// same as a normal `import` — so neither is a dynamic-reference hazard.
import util = require("./util.js");
import legacy = require("./legacy.js");

console.log(util.greet("world"));
console.log(legacy.version);
