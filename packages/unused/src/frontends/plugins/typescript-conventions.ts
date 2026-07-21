/** Compiled-in TypeScript convention plugins migrated from frontend composition. */

import { entrypointId } from "../../core/ir/index.js";
import {
  githubActionsRunRoots,
  nativeConfigScriptRoots,
  taskfileCommandRoots,
} from "../ts/convention-references.js";
import { prefixRepositoryPath } from "./rebase.js";
import type { ConventionPlugin } from "./types.js";

const PLUGIN_VERSION = "0.1.0";

/** Source files executed by workflow, task-runner, or native-build config. */
export const typescriptConfigCarriersConventionPlugin: ConventionPlugin = {
  kind: "convention",
  id: "convention:typescript-config-carriers",
  version: PLUGIN_VERSION,
  languages: ["ts"],
  applies(context) {
    return context.fragment.claimInputs.analysisFiles.size > 0;
  },
  async analyze(context) {
    const { boundary } = context.fragment;
    const analyzedFiles = new Set(
      [...context.fragment.claimInputs.analysisFiles].map((file) =>
        boundaryRelativePath(boundary.rootRelDir, file),
      ),
    );
    const hits = [
      ...(await githubActionsRunRoots(
        boundary.rootDir,
        analyzedFiles,
        context.repository.gitignore,
      )),
      ...(await taskfileCommandRoots(
        boundary.rootDir,
        analyzedFiles,
        context.repository.gitignore,
      )),
      ...(await nativeConfigScriptRoots(
        boundary.rootDir,
        analyzedFiles,
        context.repository.gitignore,
      )),
    ];
    return {
      nodes: hits.map((hit) => {
        const file = prefixRepositoryPath(boundary.rootRelDir, hit.file);
        return {
          kind: "entrypoint" as const,
          id: entrypointId("config", file),
          entryKind: "config" as const,
          file,
          reason: hit.reason,
        };
      }),
    };
  },
};

function boundaryRelativePath(rootRelDir: string, repositoryFile: string): string {
  if (rootRelDir === "") return repositoryFile;
  const prefix = `${rootRelDir}/`;
  if (!repositoryFile.startsWith(prefix)) {
    throw new Error(
      `TypeScript convention file ${repositoryFile} is outside boundary ${rootRelDir}`,
    );
  }
  return repositoryFile.slice(prefix.length);
}
