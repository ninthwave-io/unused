/**
 * Typed internal plugin contracts for repository-level polyglot analysis
 * (ADR 0013).
 *
 * These are intentionally not an external loading ABI. TypeScript, Elixir,
 * Rust, and the Rustler bridge prove the contracts while plugins are compiled
 * into `unused`. External loading can be designed later without preserving
 * accidental pre-release details from this interface.
 */

import type { DependencyClaimInput } from "../../core/analysis/claims.js";
import type { PerformanceTracker } from "../../core/analysis/index.js";
import type { Provenance, Suppression } from "../../core/claims/index.js";
import type { HazardAnnotation, IREdge, IRGraph, IRNode, Site } from "../../core/ir/index.js";

/** Stable, open language id used in graph/claim identity (`ts`, `ex`, `rs`). */
export type LanguageId = string;

/** POSIX path relative to the repository analysis root; `""` denotes the root. */
export type RepositoryRelativePath = string;

export type PluginKind = "language" | "convention" | "bridge";

/** One independently analyzable project discovered inside a repository. */
export interface ProjectBoundary {
  /** Deterministic identity, normally `<language>:<rootRelDir>`. */
  readonly id: string;
  readonly language: LanguageId;
  /** Absolute project directory used by the frontend/toolchain. */
  readonly rootDir: string;
  /** Project directory relative to the repository root (`""` for root). */
  readonly rootRelDir: RepositoryRelativePath;
  /** Manifest relative to the repository root (`package.json`, `mix.exs`, ...). */
  readonly manifest: RepositoryRelativePath;
  /** Human-readable ecosystem/project kind, e.g. `npm-workspace`, `mix`, `cargo`. */
  readonly projectKind: string;
}

/** Shared immutable context supplied to every plugin invocation. */
export interface RepositoryAnalysisContext {
  readonly rootDir: string;
  readonly gitignore: boolean;
  /** One shared, gitignore-bounded manifest inventory for all plugins. */
  readonly manifests: RepositoryManifestInventory;
  readonly now: Date;
  readonly toolVersion: string;
  readonly configPath?: string;
  readonly performance?: PerformanceTracker;
}

export interface RepositoryManifestInventory {
  readonly packageJsonDirs: readonly string[];
  readonly mixExsDirs: readonly string[];
  readonly cargoTomlDirs: readonly string[];
}

/** Capability declaration is descriptive and test/audit-visible, not marketing text. */
export interface LanguageCapabilities {
  readonly files: boolean;
  readonly symbols: boolean;
  readonly dependencies: boolean;
  readonly testPartition: boolean;
  readonly configPartition: boolean;
  readonly compilerExecution: boolean;
  readonly mutation: boolean;
}

export type PluginDiagnosticSeverity = "info" | "warning" | "error";

/** A deterministic plugin diagnostic; paths/sites remain repository-relative. */
export interface PluginDiagnostic {
  readonly pluginId: string;
  readonly boundaryId?: string;
  readonly severity: PluginDiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly site?: Site;
}

/** Core claim inputs owned by one language boundary. */
export interface FrontendClaimInputs {
  readonly fileLineCounts: ReadonlyMap<string, number>;
  readonly dependencies?: readonly DependencyClaimInput[];
  readonly selfDependencyIds?: ReadonlySet<string>;
  readonly units: readonly { readonly rootRelDir: string; readonly name: string | null }[];
  /** Every repository-relative file whose graph facts belong to this boundary. */
  readonly analysisFiles: ReadonlySet<string>;
  /** Repository-relative files eligible to receive claims from this boundary. */
  readonly claimableFiles: ReadonlySet<string>;
}

/**
 * A complete repository-relative frontend result before global reachability.
 * Bridge plugins can add edges to this graph before claims are emitted.
 */
export interface FrontendGraphFragment {
  readonly pluginId: string;
  readonly language: LanguageId;
  readonly boundary: ProjectBoundary;
  readonly graph: IRGraph;
  readonly provenance: Provenance;
  /** Frontend display/counter metadata retained without embedding wire-format claims. */
  readonly metadata: {
    readonly projectName: string;
    readonly fileCount: number;
    readonly workspaceCount: number;
    readonly configHash: string;
    readonly gateThreshold: "high" | "medium" | "low";
  };
  readonly claimInputs: FrontendClaimInputs;
  /** Stable-id metadata reapplied after repository-wide claim emission. */
  readonly claimAnnotations: ReadonlyMap<
    string,
    {
      readonly suppression?: Suppression;
      readonly package?: string;
    }
  >;
  readonly diagnostics: readonly PluginDiagnostic[];
}

/** Pure graph additions returned by convention and bridge plugins. */
export interface GraphContribution {
  readonly nodes?: readonly IRNode[];
  readonly edges?: readonly IREdge[];
  readonly hazards?: readonly HazardAnnotation[];
  readonly diagnostics?: readonly PluginDiagnostic[];
}

interface PluginBase<K extends PluginKind> {
  readonly kind: K;
  /** Globally unique stable id (`language:typescript`, `bridge:rustler`). */
  readonly id: string;
  readonly version: string;
}

/** Detects and analyzes one language ecosystem. */
export interface LanguageFrontendPlugin extends PluginBase<"language"> {
  readonly language: LanguageId;
  readonly capabilities: LanguageCapabilities;
  discover(context: RepositoryAnalysisContext): Promise<readonly ProjectBoundary[]>;
  analyze(
    context: RepositoryAnalysisContext,
    boundary: ProjectBoundary,
  ): Promise<FrontendGraphFragment>;
}

export interface ConventionPluginContext {
  readonly repository: RepositoryAnalysisContext;
  readonly fragment: FrontendGraphFragment;
}

/** Adds framework/tool roots, references, or hazards within a language boundary. */
export interface ConventionPlugin extends PluginBase<"convention"> {
  readonly languages: readonly LanguageId[];
  applies(context: ConventionPluginContext): boolean | Promise<boolean>;
  analyze(context: ConventionPluginContext): Promise<GraphContribution>;
}

export interface BridgePluginContext {
  readonly repository: RepositoryAnalysisContext;
  readonly fragments: readonly FrontendGraphFragment[];
  /** Complete merged graph before this bridge's contribution is applied. */
  readonly graph: IRGraph;
}

/** Adds provenance-bearing cross-language edges after fragment merge. */
export interface BridgePlugin extends PluginBase<"bridge"> {
  /** Every listed language must be present before the bridge is considered. */
  readonly requiredLanguages: readonly LanguageId[];
  applies(context: BridgePluginContext): boolean | Promise<boolean>;
  analyze(context: BridgePluginContext): Promise<GraphContribution>;
}

export type AnalyzerPlugin = LanguageFrontendPlugin | ConventionPlugin | BridgePlugin;

/** Internal status for every detected boundary; no boundary silently disappears. */
export type BoundaryAnalysisRecord =
  | {
      readonly status: "complete";
      readonly pluginId: string;
      readonly boundary: ProjectBoundary;
      readonly fragment: FrontendGraphFragment;
    }
  | {
      readonly status: "unsupported" | "failed";
      readonly pluginId: string;
      readonly boundary: ProjectBoundary;
      readonly diagnostic: PluginDiagnostic;
    };

/** Error wrapper that always identifies the plugin and optional project boundary. */
export class PluginExecutionError extends Error {
  readonly pluginId: string;
  readonly boundaryId?: string;

  constructor(pluginId: string, boundaryId: string | undefined, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      boundaryId === undefined
        ? `plugin ${pluginId} failed: ${detail}`
        : `plugin ${pluginId} failed for boundary ${boundaryId}: ${detail}`,
      { cause },
    );
    this.name = "PluginExecutionError";
    this.pluginId = pluginId;
    if (boundaryId !== undefined) this.boundaryId = boundaryId;
  }
}

/** Execute plugin work with the ADR 0013 attribution contract. */
export async function executePluginOperation<T>(
  pluginId: string,
  boundaryId: string | undefined,
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PluginExecutionError) throw error;
    throw new PluginExecutionError(pluginId, boundaryId, error);
  }
}
