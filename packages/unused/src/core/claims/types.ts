/**
 * The claim-run contract — PRD §4 (claim schema), architecture.md §1/§3,
 * ADR 0006 (schema versioning + claim identity).
 *
 * This module is the language-agnostic wire format every reporter (TTY,
 * `--json`, SARIF) and the MCP server render from. It never imports from
 * `frontends`, `cli`, `reporters`, or `mcp` (dependency-cruiser, ADR 0003).
 *
 * `schema/claim-run.schema.json` and `schema/deletion-plan.schema.json` are the
 * hand-authored JSON Schema mirrors of this file — keep them in lockstep on any
 * change to their respective contracts.
 */

/**
 * ADR 0006 semver policy: bump on a MAJOR/MINOR/PATCH change to this
 * contract. 1.4.0: additive boundary/partition completeness observability —
 * MINOR per ADR 0006.
 */
export const SCHEMA_VERSION = "1.4.0";

// ---------------------------------------------------------------------------
// Enums (PRD §4, ADR 0006 open/closed policy)
// ---------------------------------------------------------------------------

/**
 * Subject kind — CLOSED enum (ADR 0006): consumers may switch on it
 * exhaustively; a new kind is a MAJOR schema-version bump.
 */
export type SubjectKind = "export" | "file" | "dependency" | "endpoint" | "test";

/**
 * Verdict — CLOSED enum with pre-reserved future values (ADR 0006):
 * consumers may switch on it exhaustively today and still compile against a
 * future minor version that starts emitting a reserved value.
 *
 * - `unused` / `test-only` / `unconsumed-endpoint` — emitted by the v1 OSS
 *   analyzer (evidence tiers 1–3).
 * - `no-runtime-traffic` — RESERVED for tier 4 (runtime evidence). Never
 *   emitted by v1; not yet bound to a subject kind (PRD §4).
 * - `no-user-engagement` — RESERVED for tier 5 (human-usage evidence).
 *   Never emitted by v1; not yet bound to a subject kind (PRD §4).
 */
export type Verdict =
  | "unused"
  | "test-only"
  | "unconsumed-endpoint"
  | "no-runtime-traffic"
  | "no-user-engagement";

/** Confidence grade — CLOSED enum (ADR 0006), a contract agents threshold on (PRD §4). */
export type Confidence = "high" | "medium" | "low";

/**
 * Evidence type — OPEN enum (ADR 0006): "evidence[].type beyond the
 * reserved five ... [is] open — consumers must tolerate unknown values
 * there." The five listed here are every value the v1 OSS analyzer's type
 * system knows about; `runtime` and `human-usage` are RESERVED for the
 * tier-4/5 hosted correlation engine and are never emitted by v1
 * (`schema/claim-run.schema.json` deliberately does not constrain this
 * field to an enum, matching the ADR).
 */
export type EvidenceType =
  | "static-reachability"
  | "test-only"
  | "cross-boundary"
  | "runtime"
  | "human-usage";

/** `endpoint` subject protocol (PRD §4). */
export type EndpointProtocol = "http" | "trpc" | "graphql";

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** Inclusive 1-based [startLine, endLine], matching the SARIF `region` mapping (PRD §4). */
export type Span = readonly [startLine: number, endLine: number];

export interface Loc {
  /** POSIX-style, repo-relative (ADR 0006 — also the canonical-id `file` field). */
  file: string;
  span: Span;
  /** Workspace/package name in a monorepo; absent outside one. */
  package?: string;
}

export interface EvidenceWindow {
  /** ISO 8601. The time window this evidence entry's silence/observation applies to. */
  start: string;
  end: string;
}

export interface Evidence {
  type: EvidenceType;
  /** One-line human-readable "why" (PRD §8 explainability bar). */
  detail: string;
  /** Where the evidence came from, e.g. `"reference-graph"`. Open (ADR 0006). */
  source: string;
  window?: EvidenceWindow;
}

export interface Provenance {
  /** e.g. `"ts-reference-graph"`. */
  analyzer: string;
  version: string;
  /** ISO 8601. */
  generatedAt: string;
}

/** Presence of this object means the claim is suppressed (PRD §4/§6). */
export interface Suppression {
  /** `/* unused:ignore <reason> *\/` — mandatory, travels into `--json`/SARIF. */
  reason: string;
  /** Policy origin. Present for structured config suppressions; optional for older inline data. */
  source?: string;
  /** The exact configured file pattern that matched this claim. */
  pattern?: string;
}

// ---------------------------------------------------------------------------
// Counterfactual deletion plans (ADR 0012 — separate from ClaimRun)
// ---------------------------------------------------------------------------

/** A resolved subject accepted by the deletion planner. */
export type DeletionPlanSubject =
  | { kind: "export"; file: string; name: string; line?: number }
  | { kind: "file"; file: string }
  | { kind: "dependency"; file: string; name: string };

/** Subjects that can appear as graph-derived deletion consequences. */
export type DeletionPlanConsequenceSubject = Exclude<DeletionPlanSubject, { kind: "dependency" }>;

/** Exact stored graph provenance for a required source edit. */
export interface DeletionPlanSite {
  file: string;
  span: {
    start: number;
    end: number;
    startLine: number;
    endLine: number;
  };
}

export interface ReExportEdit {
  kind: "remove-re-export";
  file: string;
  line: number;
  exportedName?: string;
  targetFile: string;
  targetName?: string;
  site: DeletionPlanSite;
}

export interface DeletionPlanStage {
  stage: number;
  newlyDead: readonly DeletionPlanConsequenceSubject[];
}

/**
 * Standalone `why --delete --json` contract. It is intentionally not nested in
 * {@link ClaimRun}: plans are counterfactual consequences, never claim truth,
 * and therefore cannot participate in summaries, baselines, or gates.
 */
interface DeletionPlanBase {
  schemaVersion: typeof SCHEMA_VERSION;
}

export type DeletionPlan =
  | (DeletionPlanBase & {
      selected: DeletionPlanConsequenceSubject;
      supported: true;
      unsupportedReason?: never;
      reExportEdits: readonly ReExportEdit[];
      stages: readonly DeletionPlanStage[];
    })
  | (DeletionPlanBase & {
      selected: DeletionPlanSubject;
      supported: false;
      unsupportedReason: string;
      reExportEdits: readonly [];
      stages: readonly [];
    });

// ---------------------------------------------------------------------------
// Subjects (one discriminated variant per kind)
// ---------------------------------------------------------------------------

interface BaseSubject<K extends SubjectKind> {
  kind: K;
  name: string;
  loc: Loc;
}

export type ExportSubject = BaseSubject<"export">;
export type FileSubject = BaseSubject<"file">;
export type DependencySubject = BaseSubject<"dependency">;
export type TestSubject = BaseSubject<"test">;

export interface EndpointSubject extends BaseSubject<"endpoint"> {
  protocol: EndpointProtocol;
  /**
   * HTTP method, present when `protocol` is `"http"` and part of claim
   * identity there — `GET /users` and `POST /users` are distinct claims
   * (PRD §4, ADR 0006 canonical-id `method` slot). Absent for `trpc`/`graphql`.
   */
  method?: string;
}

export type Subject =
  | ExportSubject
  | FileSubject
  | DependencySubject
  | EndpointSubject
  | TestSubject;

// ---------------------------------------------------------------------------
// Claims — the kind -> verdict binding is encoded as a discriminated union
// (PRD §4: "verdict vocabulary is bound to subject kind ... enforced rule,
// not convention"). This makes an invalid pairing a compile-time error for
// any claim built through these types. See `isValidKindVerdict` below for
// the runtime counterpart, needed wherever a claim is built from untyped
// data (parsed JSON, baseline files, etc).
// ---------------------------------------------------------------------------

interface BaseClaim<S extends Subject, V extends Verdict> {
  id: string;
  /** Stable language id (`ts`, `ex`, `rs`, ...); see ADR 0006 for identity compatibility. */
  language: string;
  subject: S;
  verdict: V;
  confidence: Confidence;
  /** Non-empty in practice (PRD §8 explainability bar); enforced by the JSON Schema, not the type. */
  evidence: readonly Evidence[];
  provenance: Provenance;
  suppression?: Suppression;
}

/** `export`/`file`/`dependency` subjects take `unused` or `test-only` (PRD §4). */
export type ExportClaim = BaseClaim<ExportSubject, "unused" | "test-only">;
export type FileClaim = BaseClaim<FileSubject, "unused" | "test-only">;
export type DependencyClaim = BaseClaim<DependencySubject, "unused" | "test-only">;

/** `endpoint` subjects always take `unconsumed-endpoint` (PRD §4). */
export type EndpointClaim = BaseClaim<EndpointSubject, "unconsumed-endpoint">;

/** `test` subjects take `test-only` — a zombie test (PRD §4). */
export type TestClaim = BaseClaim<TestSubject, "test-only">;

export type Claim = ExportClaim | FileClaim | DependencyClaim | EndpointClaim | TestClaim;

/**
 * The runtime kind -> verdict binding (PRD §4), mirroring the discriminated
 * union above. Exported so reporters/tests can enumerate it without
 * re-deriving the mapping.
 */
export const KIND_VERDICTS: Readonly<Record<SubjectKind, readonly Verdict[]>> = {
  export: ["unused", "test-only"],
  file: ["unused", "test-only"],
  dependency: ["unused", "test-only"],
  endpoint: ["unconsumed-endpoint"],
  test: ["test-only"],
};

/**
 * Runtime guard for the kind -> verdict binding. "A claim pairing a kind
 * with a verdict outside this mapping is invalid" (PRD §4). Use this
 * wherever a claim is assembled from data the type system hasn't already
 * narrowed (e.g. deserialised JSON, a baseline file, an analyzer building a
 * claim dynamically) — the `Claim` discriminated union above only protects
 * statically-constructed claims.
 */
export function isValidKindVerdict(kind: SubjectKind, verdict: Verdict): boolean {
  return KIND_VERDICTS[kind].includes(verdict);
}

// ---------------------------------------------------------------------------
// Top level: the claim run
// ---------------------------------------------------------------------------

/**
 * T5.3 CI-seconds estimate (docs/design/report-and-badge.md §3): "v1 uses
 * test-file count × configurable average when no timing data exists, and
 * labels the number 'estimated' — the report never presents an estimate as a
 * measurement." `estimated: true` is a literal, always present, so a
 * consumer can never mistake this figure for a measured timing. Present on
 * `ClaimSummary` only when `count > 0` — a zero-zombie run omits the block
 * entirely rather than reporting a zero (see `summary.ts`'s
 * `computeZombieTestsSummary`).
 */
export interface ZombieTestsSummary {
  /** Number of zombie `test` claims in this run. */
  count: number;
  /** `count * avgSecondsPerTestFile`. */
  estCiSecondsPerRun: number;
  /** Always `true` — a labelled estimate, never presented as measured. */
  estimated: true;
  /**
   * The per-test-file average (seconds) used to compute the estimate —
   * config `ciSecondsPerTestFile`, default 5 (`DEFAULT_CI_SECONDS_PER_TEST_FILE`).
   */
  avgSecondsPerTestFile: number;
}

export interface ClaimSummary {
  byKind: Record<SubjectKind, number>;
  byConfidence: Record<Confidence, number>;
  /**
   * Overlap/nesting-aware line count across non-suppressed dead-verdict
   * claims (phasing.md T3.4) — see `summary.ts` for the merge rules.
   */
  estDeletableLoc: number;
  /** T5.3 CI-seconds estimate. Absent on a zero-zombie run. */
  zombieTests?: ZombieTestsSummary;
}

export interface AnalysisPartitionCompletion {
  production: "complete";
  config: "complete";
  test: "complete" | "incomplete";
}

/** A language boundary that contributed complete or conservatively bounded facts. */
export interface AnalysisBoundary {
  status: "complete" | "partial";
  /** Stable language-plugin id, e.g. `language:typescript`. */
  pluginId: string;
  /** Stable repository-analysis boundary id, e.g. `ts:.` or `ex:services/api`. */
  boundaryId: string;
  /** Open language id used by claims from this boundary. */
  language: string;
  /** Files analyzed by this boundary after ignore handling. */
  fileCount: number;
  /** Package/application/crate units owned by this boundary. */
  workspaceCount: number;
  /** Per-partition proof completeness; `partial` iff any partition is incomplete. */
  partitions: AnalysisPartitionCompletion;
}

/**
 * @deprecated Use {@link AnalysisBoundary}; retained as the source-compatible
 * complete-boundary shape exported before schema 1.4 required partition metadata.
 */
export type CompletedAnalysisBoundary = Omit<AnalysisBoundary, "status" | "partitions"> & {
  status: "complete";
  partitions?: {
    production: "complete";
    config: "complete";
    test: "complete";
  };
};

export interface ClaimRun {
  schemaVersion: string;
  tool: {
    name: string;
    version: string;
  };
  run: {
    root: string;
    /** Absent when analysis doesn't happen inside a git repo with a resolvable HEAD (PRD §4). */
    commit?: string;
    configHash: string;
    /** ISO 8601. */
    startedAt: string;
    durationMs: number;
    /** Deterministic, boundary-id-sorted record of every analyzed language boundary. */
    boundaries: readonly AnalysisBoundary[];
  };
  claims: readonly Claim[];
  summary: ClaimSummary;
}
