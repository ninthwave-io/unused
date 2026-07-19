import * as path from "node:path";

declare class NodejsFunction {
  constructor(scope: unknown, id: string, options: { entry: string; handler: string });
}

declare namespace Settings {
  var __dirname: string;
}

declare function dynamicDirectory(): string;
declare function dynamicPathLibrary(): typeof path;

namespace ProvenNamespace {
  const runtimeDir = path.join(__dirname, "..", "..", "runtime", "src");

  new NodejsFunction({}, "NamespaceLocalWorker", {
    entry: path.join(runtimeDir, "namespace-local-handler.ts"),
    handler: "handler",
  });
}

namespace ShadowedNamespace {
  var __dirname = dynamicDirectory();

  new NodejsFunction({}, "NamespaceShadowedWorker", {
    entry: path.join(__dirname, "..", "..", "runtime", "src", "namespace-shadowed.ts"),
    handler: "handler",
  });
}

module ShadowedModule {
  var path = dynamicPathLibrary();

  new NodejsFunction({}, "ModuleShadowedWorker", {
    entry: path.join(__dirname, "..", "..", "runtime", "src", "module-shadowed.ts"),
    handler: "handler",
  });
}

export function buildStack(): NodejsFunction {
  const runtimeDir = path.join(__dirname, "..", "..", "runtime");
  new NodejsFunction({}, "LocalWorker", {
    entry: "local-handler.ts",
    handler: "handler",
  });
  new NodejsFunction({}, "NamespaceWorker", {
    entry: path.join(__dirname, "..", "..", "runtime", "src", "namespace-handler.ts"),
    handler: "handler",
  });
  return new NodejsFunction({}, "Worker", {
    entry: path.join(runtimeDir, "src", "handler.ts"),
    handler: "handler",
  });
}
