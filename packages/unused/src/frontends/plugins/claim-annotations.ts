/** Claim metadata derivable before repository-wide reachability. */

import type { Evidence } from "../../core/claims/index.js";
import type { IRGraph } from "../../core/ir/index.js";
import {
  type ConfigUnit,
  collectConfigSuppressionAnnotations,
  type UnusedConfig,
} from "../ts/config.js";
import type { FrontendClaimAnnotation, FrontendClaimInputs } from "./types.js";

export function claimAnnotationKey(kind: string, file: string, name?: string): string {
  return `${kind}\0${file}\0${name ?? ""}`;
}

export function collectFrontendClaimAnnotations(input: {
  readonly graph: IRGraph;
  readonly config: UnusedConfig;
  readonly units: readonly ConfigUnit[];
  readonly claimInputs: FrontendClaimInputs;
  readonly evidence?: ReadonlyMap<string, readonly Evidence[]>;
}): ReadonlyMap<string, FrontendClaimAnnotation> {
  const hasSuppressions =
    input.config.suppressions.length > 0 ||
    Object.values(input.config.workspaces).some((workspace) => workspace.suppressions.length > 0);
  if (!hasSuppressions) {
    return new Map(
      [...(input.evidence ?? [])].map(([key, evidence]) => [key, { evidence }] as const),
    );
  }
  const candidates: Array<{
    key: string;
    kind: "file" | "export" | "test" | "dependency";
    file: string;
  }> = [];
  for (const node of input.graph.nodes()) {
    if (node.kind === "file") {
      candidates.push({
        key: claimAnnotationKey("file", node.path, node.path),
        kind: "file",
        file: node.path,
      });
    } else if (node.kind === "symbol" && node.local) {
      candidates.push({
        key: claimAnnotationKey("export", node.file, node.exportedName),
        kind: "export",
        file: node.file,
      });
    }
  }
  for (const entrypoint of input.graph.entrypoints()) {
    if (entrypoint.entryKind !== "test") continue;
    candidates.push({
      key: claimAnnotationKey("test", entrypoint.file, entrypoint.file),
      kind: "test",
      file: entrypoint.file,
    });
  }
  for (const dependency of input.claimInputs.dependencies ?? []) {
    candidates.push({
      key: claimAnnotationKey("dependency", dependency.loc.file, dependency.packageName),
      kind: "dependency",
      file: dependency.loc.file,
    });
  }

  const suppressions = collectConfigSuppressionAnnotations(candidates, input.config, input.units);
  const annotations = new Map<string, FrontendClaimAnnotation>();
  for (const [key, suppression] of suppressions) annotations.set(key, { suppression });
  for (const [key, evidence] of input.evidence ?? []) {
    annotations.set(key, { ...annotations.get(key), evidence });
  }
  return annotations;
}
