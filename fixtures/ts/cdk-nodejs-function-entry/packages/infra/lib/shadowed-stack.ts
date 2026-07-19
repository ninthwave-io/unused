import { join } from "node:path";

declare class NodejsFunction {
  constructor(scope: unknown, id: string, options: { entry: string; handler: string });
}
declare const chooseDirectory: boolean;
declare function dynamicDirectory(): string;

if (chooseDirectory) {
  var __dirname = dynamicDirectory();
}

export function buildShadowedStack(): NodejsFunction {
  return new NodejsFunction({}, "ShadowedWorker", {
    entry: join(__dirname, "../../runtime/src/orphan.ts"),
    handler: "handler",
  });
}
