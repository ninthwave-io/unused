// A `*.spec.ts` basename ⇒ a `test` reachability root. It keeps `only-tested.ts`
// alive and is itself never claimed. (Named `.spec.ts`, not `.test.ts`, only so
// the repo's own vitest `*.test.ts` include glob does not try to run this fixture
// as a suite; the analyzer recognizes `*.test.*` and `*.spec.*` identically.)
import { helper } from "./only-tested.js";

if (helper() !== 42) throw new Error("boom");
