import { buildFixture } from "../src/shared-fixture.js";

// The mutual half of the cluster: a second, independent test file that also
// reaches only src/shared-fixture.ts — itself a zombie test too.
if (buildFixture() * 2 !== 14) throw new Error("unexpected");
