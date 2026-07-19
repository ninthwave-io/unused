// Outside config "project": ["src/**"] scope, so this file itself can never
// receive an "unused" claim, whether or not anything imports it — see
// labels.yaml's description for why it is deliberately unlabelled rather
// than labelled "alive" (claimability scope is not the same question as
// liveness). Still discovered/parsed, so this import edge keeps
// src/helper.ts correctly alive.
import { helperFn } from "../src/helper.js";

console.log(helperFn());
