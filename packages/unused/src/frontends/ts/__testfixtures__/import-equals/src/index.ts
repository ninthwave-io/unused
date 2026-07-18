// TSImportEqualsDeclaration (CJS interop). util.ts / legacy.ts are imported ONLY
// this way — the previous silent-drop of this node made them false "unused".
import util = require("./util.js");
import legacy = require("./legacy.js");

console.log(util.greet("world"));
console.log(legacy.version);
