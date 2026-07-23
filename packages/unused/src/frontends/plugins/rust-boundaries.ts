/** Rust-specific ownership of the shared repository source inventory. */

import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ProjectBoundary } from "./types.js";

const RUST_SOURCE_CANDIDATES: unique symbol = Symbol("rust-source-candidates");

interface RustProjectBoundary extends ProjectBoundary {
  /** Lexically owned candidates; the Rust frontend still verifies realpath containment. */
  readonly [RUST_SOURCE_CANDIDATES]: readonly string[];
}

export interface RustBoundaryPartition {
  readonly boundaries: readonly ProjectBoundary[];
  /** Number of repository candidates classified, independent of boundary count. */
  readonly candidateInspections: number;
  /** Ancestor-map probes make the path-depth term explicit and testable. */
  readonly ancestorProbes: number;
}

/**
 * Partition the shared Rust inventory once during boundary discovery.
 *
 * Each source candidate walks its lexical ancestors until it finds the nearest
 * selected Cargo boundary. This is O(files × path depth + boundaries), rather
 * than filtering the complete repository inventory once per boundary. The
 * shared discovery contract supplies absolute paths in the same resolved
 * lexical root and does not follow symlink entries, so this partition performs
 * no filesystem work. The resulting arrays remain an optimization only:
 * `rustSources` canonicalizes every selected descriptor and verifies realpath
 * containment before the Rust frontend reads it.
 */
export function partitionRustSourceCandidates(
  repositoryRoot: string,
  boundaries: readonly ProjectBoundary[],
  sourceCandidates: readonly string[],
): RustBoundaryPartition {
  const root = resolve(repositoryRoot);
  const candidatesByRoot = new Map<string, string[]>();
  for (const boundary of boundaries) candidatesByRoot.set(resolve(boundary.rootDir), []);

  let candidateInspections = 0;
  let ancestorProbes = 0;
  for (const candidate of sourceCandidates) {
    candidateInspections += 1;
    if (!isAbsolute(candidate)) {
      throw new Error(`Rust source candidate must be absolute: ${candidate}`);
    }
    const source = resolve(candidate);
    if (!contains(root, source)) continue;
    let directory = dirname(source);
    while (contains(root, directory)) {
      ancestorProbes += 1;
      const owner = candidatesByRoot.get(directory);
      if (owner !== undefined) {
        owner.push(candidate);
        break;
      }
      if (directory === root) break;
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }

  return {
    boundaries: boundaries.map((boundary) =>
      withRustSourceCandidates(boundary, candidatesByRoot.get(resolve(boundary.rootDir)) ?? []),
    ),
    candidateInspections,
    ancestorProbes,
  };
}

/** Retrieve the immutable discovery-time slice without a process-global cache. */
export function rustSourceCandidatesForBoundary(boundary: ProjectBoundary): readonly string[] {
  const candidates = (boundary as Partial<RustProjectBoundary>)[RUST_SOURCE_CANDIDATES];
  if (candidates === undefined) {
    throw new Error(`Rust boundary ${boundary.id} has no source-candidate partition`);
  }
  return candidates;
}

function withRustSourceCandidates(
  boundary: ProjectBoundary,
  candidates: readonly string[],
): RustProjectBoundary {
  return {
    ...boundary,
    [RUST_SOURCE_CANDIDATES]: Object.freeze([...candidates]),
  };
}

function contains(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}
