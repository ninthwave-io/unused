import { MyStack } from "../lib/my-stack.js";

// The AWS CDK app entrypoint declared in cdk.json#app ("npx tsx bin/app.ts"),
// also matched by the CDK `bin/` entry-script convention. Nothing statically
// imports a CDK bin entry — the `cdk` CLI invokes it by reading cdk.json — so a
// pure reference graph would flag this file (and every stack it instantiates)
// dead. The CDK preset seeds it as a production entrypoint.
new MyStack();
