// Outside "project": ["src/**"] — never itself claimable, even though
// nothing imports it. It still contributes a real graph edge, but it is not a
// production root and therefore does not keep src/helper.ts live.
import { helper } from "../src/helper.js";

console.log(helper());
