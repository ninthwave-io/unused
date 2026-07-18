import { helper } from "@app/util";
// "@app/missing" resolves under the same "@app/*" alias root, but no file
// exists at src/app/missing.ts — a dangling alias import (e.g. left behind
// by a rename). This must degrade to a hazard, not a crash, and must not
// poison liveness for the rest of this file or the alias root.
import { missingHelper } from "@app/missing";

console.log(helper());
console.log(missingHelper);
