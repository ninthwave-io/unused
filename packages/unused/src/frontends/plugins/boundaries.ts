/** Shared project-boundary selection over the gitignore-bounded inventory. */

import { relative, sep } from "node:path";
import type { ProjectBoundary } from "./types.js";

export interface BoundaryDescriptor {
  readonly language: string;
  readonly manifestName: string;
  readonly projectKind: string;
}

/**
 * Convert visible manifest directories to deterministic, non-overlapping
 * frontend boundaries. A parent manifest owns descendants of the same
 * ecosystem (workspace/umbrella); sibling projects remain separate.
 */
export function selectProjectBoundaries(
  repositoryRoot: string,
  manifestDirs: readonly string[],
  descriptor: BoundaryDescriptor,
): ProjectBoundary[] {
  const candidates = [...new Set(manifestDirs.map((dir) => toPosixRel(repositoryRoot, dir)))].sort(
    byDepthThenPath,
  );
  const selected: string[] = [];
  for (const candidate of candidates) {
    if (selected.some((parent) => contains(parent, candidate))) continue;
    selected.push(candidate);
  }
  return selected.map((rootRelDir) => ({
    id: `${descriptor.language}:${rootRelDir === "" ? "." : rootRelDir}`,
    language: descriptor.language,
    rootDir:
      rootRelDir === ""
        ? repositoryRoot
        : `${repositoryRoot}${sep}${rootRelDir.split("/").join(sep)}`,
    rootRelDir,
    manifest:
      rootRelDir === "" ? descriptor.manifestName : `${rootRelDir}/${descriptor.manifestName}`,
    projectKind: descriptor.projectKind,
  }));
}

function contains(parent: string, candidate: string): boolean {
  return parent === "" || candidate === parent || candidate.startsWith(`${parent}/`);
}

function byDepthThenPath(a: string, b: string): number {
  const depth = pathDepth(a) - pathDepth(b);
  return depth !== 0 ? depth : a < b ? -1 : a > b ? 1 : 0;
}

function pathDepth(path: string): number {
  return path === "" ? 0 : path.split("/").length;
}

function toPosixRel(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/");
  if (value === "") return "";
  if (value === ".." || value.startsWith("../")) {
    throw new Error(`project boundary escapes repository root: ${path}`);
  }
  return value;
}
