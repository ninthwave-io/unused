// Outside "project": ["src/**"] — never itself claimable, even though
// nothing imports IT. It still acts as a real importer: this edge is what
// keeps src/helper.ts correctly referenced.
import { helper } from "../src/helper.js";

console.log(helper());
