/**
 * `unused mcp` — the MCP server (stdio) over the same analysis engine (T8.3,
 * docs/phasing.md M8; PRD §5; architecture.md §1/§7). Read-only, zero network:
 * it exposes the reference-graph analysis to a coding agent through three tools,
 * and makes no calls the CLI wouldn't (the zero-telemetry, no-network-in-the-
 * local-path constraint — CLAUDE.md).
 *
 * Transport is stdio via the official `@modelcontextprotocol/sdk` (the stable
 * v1 line — docs/research/parser-and-language-stack-2026-07.md §5). We use the
 * low-level `Server` with hand-authored JSON Schemas rather than the zod-backed
 * `McpServer` sugar, so the tool shapes are exactly PRD §5's contract with no
 * extra dependency.
 *
 * ## Tools (PRD §5)
 *  - **`find_unused({ kinds?, minConfidence?, paths? }) → { claims }`** — the
 *    same claim objects `--json` emits (schema parity), filtered by kind,
 *    confidence floor, and repo-relative path prefix.
 *  - **`why_alive({ symbol }) → { alive, paths, entrypointKind }`** — the
 *    differentiator: it answers for ANY symbol, not only flagged-dead ones
 *    (PRD §5). Our documented additive extensions: `testOnly`, structured
 *    `pathDetails`, and — when the subject is dead — `verdict`/`confidence`/
 *    `evidence`/`hazards`.
 *  - **`usage_evidence({ endpoint }) → { evidence }`** — the static + test-only
 *    evidence for a named subject, plus explicit `notConfigured` entries for the
 *    runtime and human-usage source slots (never an empty array — PRD §5, the
 *    ADR 0002 credential-boundary contract: those sources are locally-driven
 *    free-tier roadmap / paid managed connectors, neither configured in v1).
 *
 * ## Staleness (one analysis per server start, re-run on config change)
 * The server analyses once at start and caches the graph/reachability/claims.
 * Each tool call re-stats the project's `.gitignore` / `package.json` /
 * `tsconfig*.json` / `unused.config.*` files; if any mtime changed it re-runs `analyzeProject`
 * before answering. Every tool result carries a `staleness` note recording when
 * the answer's analysis was taken and whether this call triggered a re-run —
 * deliberately simple (mtime of config files only, not a full source watch).
 */

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve as resolvePath, sep } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { whyAlive } from "../core/analysis/index.js";
import type { Claim, Confidence, Evidence, SubjectKind } from "../core/claims/index.js";
import {
  type AnalyzeOptions,
  type AnalyzeWithGraph,
  analyzeProjectWithGraph,
} from "../frontends/ts/analyze.js";
import { ConfigError } from "../frontends/ts/config.js";
import { ancestorGitignoreFiles } from "../frontends/ts/discover.js";
import { UnsupportedProjectError } from "../frontends/ts/workspaces.js";
import { filterClaims, renderWhyPath } from "../reporters/index.js";

export const MCP_MODULE = "mcp" as const;

const VALID_KINDS: readonly SubjectKind[] = ["export", "file", "dependency", "endpoint", "test"];
const VALID_CONFIDENCE: readonly Confidence[] = ["high", "medium", "low"];
/** Config files whose mtime a change to invalidates the cached analysis. */
const WATCHED_CONFIG_RE =
  /^(?:\.gitignore|package\.json|tsconfig.*\.json|unused\.config\.(?:jsonc|json))$/i;
const WATCH_SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
/** Hidden directories whose contents participate in discovery/reachability. */
const WATCH_HIDDEN_DIRS = new Set([".github", ".storybook"]);
/** Bound the config-signature walk so a pathological tree can't stall a tool call. */
const WATCH_FILE_CAP = 20_000;

// ---------------------------------------------------------------------------
// Cached analysis with mtime-based staleness (one analysis per server start)
// ---------------------------------------------------------------------------

interface Staleness {
  /** ISO 8601 timestamp of the analysis this answer was computed from. */
  readonly analyzedAt: string;
  /** `true` ⇒ this call detected a config change and re-ran the analysis. */
  readonly reanalyzedOnThisCall: boolean;
  readonly note: string;
}

class ServerState {
  private cache:
    | {
        readonly analysis: AnalyzeWithGraph;
        readonly signature: string;
        readonly analyzedAt: string;
      }
    | undefined;

  constructor(
    private readonly root: string,
    private readonly options: AnalyzeOptions,
  ) {}

  /** The initial analysis (server start). Throws on a config/analysis error so the caller can map the exit code. */
  async prime(): Promise<AnalyzeWithGraph> {
    const analysis = await analyzeProjectWithGraph(this.root, this.options);
    this.cache = {
      analysis,
      signature: await configSignature(this.root),
      analyzedAt: new Date().toISOString(),
    };
    return analysis;
  }

  /** The current analysis, re-run first if any watched config file changed since the cached one. */
  async current(): Promise<{ analysis: AnalyzeWithGraph; staleness: Staleness }> {
    const signature = await configSignature(this.root);
    let reanalyzed = false;
    if (this.cache === undefined || this.cache.signature !== signature) {
      const analysis = await analyzeProjectWithGraph(this.root, this.options);
      this.cache = { analysis, signature, analyzedAt: new Date().toISOString() };
      reanalyzed = true;
    }
    const cache = this.cache;
    return {
      analysis: cache.analysis,
      staleness: {
        analyzedAt: cache.analyzedAt,
        reanalyzedOnThisCall: reanalyzed,
        note: reanalyzed
          ? "A watched discovery/config file (.gitignore / package.json / tsconfig / unused.config) changed since the last analysis — re-analysed for this call."
          : "Answered from the cached analysis; no watched discovery/config file (.gitignore / package.json / tsconfig / unused.config) has changed since it was taken.",
      },
    };
  }
}

/**
 * A stable string over the mtimes of every watched config file under `root`
 * (`package.json`, `tsconfig*.json`, `unused.config.*`). A byte difference means
 * a config changed — the signal to re-analyse. Deliberately narrow (config
 * files only): a full source-file watch is out of scope for v1 (PRD §7 — no
 * watch mode), and re-analysing on config drift covers the cases that actually
 * change what "unused" means (entrypoints, paths, presets, ignores).
 */
export async function configSignature(root: string): Promise<string> {
  const entries = new Set<string>();
  let budget = WATCH_FILE_CAP;
  const walk = async (dir: string): Promise<void> => {
    if (budget <= 0) return;
    let dirents: Dirent[];
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirents) {
      if (budget <= 0) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          WATCH_SKIP_DIRS.has(entry.name) ||
          (entry.name.startsWith(".") && !WATCH_HIDDEN_DIRS.has(entry.name))
        ) {
          continue;
        }
        await walk(full);
      } else if (entry.isFile() && WATCHED_CONFIG_RE.test(entry.name)) {
        budget -= 1;
        try {
          const st = await stat(full);
          entries.add(`${toPosixRel(root, full)}@${st.mtimeMs}`);
        } catch {
          // unreadable — skip; its disappearance still changes the signature
        }
      }
    }
  };
  await walk(root);
  for (const path of await ancestorGitignoreFiles(root)) {
    try {
      const st = await stat(path);
      entries.add(`${toPosixRel(root, path)}@${st.mtimeMs}`);
    } catch {
      // A disappearance changes the signature by removing the old entry.
    }
  }
  return [...entries].sort().join("\n");
}

function toPosixRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

// ---------------------------------------------------------------------------
// Tool definitions (PRD §5 shapes)
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "find_unused",
    description:
      "List unused/test-only/unconsumed claims for the project, in the same claim schema as `unused --json`. Read-only, no network. Optional filters: `kinds` (subject kinds), `minConfidence` (floor), `paths` (repo-relative path prefixes).",
    inputSchema: {
      type: "object",
      properties: {
        kinds: {
          type: "array",
          items: { type: "string", enum: VALID_KINDS },
          description: "Restrict to these subject kinds.",
        },
        minConfidence: {
          type: "string",
          enum: VALID_CONFIDENCE,
          description: "Drop claims below this confidence floor.",
        },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Repo-relative path prefixes; a claim is kept if its file starts with any.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "why_alive",
    description:
      "Explain whether a symbol or file is alive and how. Answers for ANY symbol, not only flagged-dead ones. Returns `{ alive, paths, entrypointKind }`: `paths` are shortest reference paths (root → … → subject), `entrypointKind` is production|config|test. Additive extensions: `testOnly` (alive only in the effective test environment; paths preserve the actual root kind and reason), `pathDetails` (structured hops), and for a dead subject `verdict`/`confidence`/`evidence`/`hazards`. `symbol` may be a bare export name, `file.ts:exportName`, or a file path.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "A bare export name, a `file.ts:exportName` qualifier, or a file path.",
        },
      },
      required: ["symbol"],
      additionalProperties: false,
    },
  },
  {
    name: "usage_evidence",
    description:
      "Evidence for a named subject: the static-reachability and test-only evidence the analyzer holds, plus explicit `notConfigured` entries for the runtime and human-usage source slots (never an empty array). Runtime/human-usage sources are locally-driven free-tier roadmap or paid managed connectors (ADR 0002), neither configured in v1.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint: {
          type: "string",
          description:
            "The subject name to gather evidence for (an endpoint, export, file, or dependency name).",
        },
      },
      required: ["endpoint"],
      additionalProperties: false,
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function normalizePrefix(p: string): string {
  let s = p.trim().replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  return s;
}

/** `find_unused` — filter the run's claims by kind / confidence floor / path prefix. */
function runFindUnused(
  claims: readonly Claim[],
  args: Record<string, unknown>,
): { claims: Claim[] } {
  const rawKinds = args["kinds"];
  const rawMinConfidence = args["minConfidence"];
  const rawPaths = args["paths"];
  const kinds = Array.isArray(rawKinds)
    ? rawKinds.filter((k): k is SubjectKind => VALID_KINDS.includes(k as SubjectKind))
    : undefined;
  const minConfidence =
    typeof rawMinConfidence === "string" &&
    VALID_CONFIDENCE.includes(rawMinConfidence as Confidence)
      ? (rawMinConfidence as Confidence)
      : undefined;
  let filtered = filterClaims(claims, {
    ...(kinds !== undefined && kinds.length > 0 ? { kinds } : {}),
    ...(minConfidence !== undefined ? { minConfidence } : {}),
  });

  const prefixes = Array.isArray(rawPaths)
    ? rawPaths.filter((p): p is string => typeof p === "string").map(normalizePrefix)
    : [];
  if (prefixes.length > 0) {
    filtered = filtered.filter((c) => prefixes.some((pre) => c.subject.loc.file.startsWith(pre)));
  }
  return { claims: filtered };
}

/** `why_alive` — project the core `whyAlive` result into the PRD §5 shape plus our documented extensions. */
function runWhyAlive(analysis: AnalyzeWithGraph, symbol: string): Record<string, unknown> {
  const result = whyAlive({
    graph: analysis.graph,
    reachability: analysis.reachability,
    claims: analysis.result.claims,
    query: symbol,
  });

  switch (result.outcome) {
    case "not-found":
      return {
        found: false,
        alive: false,
        entrypointKind: null,
        paths: [],
        message: `No symbol or file matching "${symbol}" was found in this project.`,
      };
    case "ambiguous":
      return {
        found: true,
        ambiguous: true,
        alive: false,
        entrypointKind: null,
        paths: [],
        candidates: result.candidates,
      };
    case "alive":
      return {
        found: true,
        alive: true,
        entrypointKind: result.entrypointKind,
        testOnly: result.testOnly,
        paths: result.paths.map((p) => renderWhyPath(p, false)),
        pathDetails: result.paths,
        subject: result.subject,
      };
    case "dead":
      return {
        found: true,
        alive: false,
        entrypointKind: null,
        paths: [],
        subject: result.subject,
        ...(result.verdict !== undefined ? { verdict: result.verdict } : {}),
        ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
        ...(result.claimId !== undefined ? { claimId: result.claimId } : {}),
        evidence: result.evidence,
        hazards: result.hazards,
      };
  }
}

/**
 * `usage_evidence` — the static/test-only evidence for a named subject, always
 * followed by the two explicit `notConfigured` source slots (PRD §5, ADR 0002).
 */
function runUsageEvidence(
  claims: readonly Claim[],
  endpoint: string,
): { endpoint: string; evidence: unknown[] } {
  const staticEvidence: Evidence[] = [];
  for (const claim of claims) {
    if (claim.subject.name !== endpoint) continue;
    for (const e of claim.evidence) {
      if (e.type === "static-reachability" || e.type === "test-only") staticEvidence.push(e);
    }
  }
  return {
    endpoint,
    evidence: [
      ...staticEvidence,
      {
        type: "runtime",
        source: "runtime-traffic (not configured)",
        notConfigured: true,
        detail:
          "No runtime-traffic source configured (OTel / APM / access logs). Locally-driven sources are free-tier roadmap; managed connectors are paid hosted (ADR 0002).",
      },
      {
        type: "human-usage",
        source: "product-analytics (not configured)",
        notConfigured: true,
        detail:
          "No product-analytics source configured (PostHog / Amplitude / Mixpanel). Locally-driven sources are free-tier roadmap; managed connectors are paid hosted (ADR 0002).",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Server wiring
// ---------------------------------------------------------------------------

function textResult(payload: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function errorResult(message: string): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Build (but do not connect) the MCP server for a primed {@link ServerState}.
 * Exported for the integration test, which drives it over an in-memory pair or
 * a spawned process.
 */
export function buildServer(state: ServerState, version: string): Server {
  const server = new Server({ name: "unused", version }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const { analysis, staleness } = await state.current();

    switch (name) {
      case "find_unused":
        return textResult({ ...runFindUnused(analysis.result.claims, args), staleness });
      case "why_alive": {
        const symbol = args["symbol"];
        if (typeof symbol !== "string" || symbol.trim() === "") {
          return errorResult("why_alive requires a non-empty `symbol` string argument.");
        }
        return textResult({ ...runWhyAlive(analysis, symbol), staleness });
      }
      case "usage_evidence": {
        const endpoint = args["endpoint"];
        if (typeof endpoint !== "string" || endpoint.trim() === "") {
          return errorResult("usage_evidence requires a non-empty `endpoint` string argument.");
        }
        return textResult({ ...runUsageEvidence(analysis.result.claims, endpoint), staleness });
      }
      default:
        return errorResult(`Unknown tool: ${name}`);
    }
  });

  return server;
}

/**
 * Start the stdio MCP server over the project at `options.cwd` (default `.`),
 * running until the client disconnects. Returns the process exit code: 0 on a
 * clean shutdown, 2 on an analysis error, 3 on a config/usage error — the same
 * PRD §3 exit contract the rest of the CLI honours, applied to the one-shot
 * analysis taken at server start.
 */
export async function runMcpServer(options: {
  cwd?: string;
  config?: string;
  gitignore?: boolean;
}): Promise<number> {
  const root = resolvePath(process.cwd(), options.cwd ?? ".");
  try {
    const stats = await stat(root);
    if (!stats.isDirectory()) {
      process.stderr.write(`unused: not a directory: ${root}\n`);
      return 2;
    }
  } catch {
    process.stderr.write(`unused: cannot read directory: ${root}\n`);
    return 2;
  }

  const state = new ServerState(root, {
    ...(options.config === undefined ? {} : { configPath: options.config }),
    ...(options.gitignore === false ? { gitignore: false } : {}),
  });
  let version = "0.1.0";
  try {
    const primed = await state.prime();
    version = primed.result.tool.version;
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`unused: ${err.message}\n`);
      return 3;
    }
    const message = err instanceof Error ? err.message : String(err);
    const prefix = err instanceof UnsupportedProjectError ? "unused:" : "unused: analysis failed:";
    process.stderr.write(`${prefix} ${message}\n`);
    return 2;
  }

  const server = buildServer(state, version);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  await new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });
  return 0;
}
