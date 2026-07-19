// Outside config "project": ["src/**"] scope, so this file itself can never
// receive an "unused" claim, whether or not anything imports it — see
// labels.yaml's description for why it is deliberately unlabelled rather
// than labelled "alive" (claimability scope is not the same question as
// liveness). It is still discovered and parsed, but because no root reaches
// this script its edge does not make src/helper.ts live (ADR 0012).
import { helperFn } from "../src/helper.js";

console.log(helperFn());
