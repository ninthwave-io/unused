// The reviewer-flagged boundary case: a namespace import re-exported by name.
// b.js's liveness must ride the explicit edge chain (namespace import edge +
// the exported local `ns`), not a blanket keep-alive.
import * as ns from "./b.js";

export { ns };
