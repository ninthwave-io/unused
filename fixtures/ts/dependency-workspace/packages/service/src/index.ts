// "shared-lib" is declared ONLY in the root package.json's "dependencies" —
// not redeclared here — and imported only from this member. Proves the
// hoisting keep-alive rule: a root-declared dep is alive if referenced by
// ANY workspace unit (assumption-set.md, "Dependency claims cover
// per-workspace dependencies only").
import { ping } from "shared-lib";

console.log(ping());
