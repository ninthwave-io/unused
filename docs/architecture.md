# Architecture — unused

Status: APPROVED at the Phase 2 gate (2026-07-18). Build contract, kept deliberately in spec form. Settled context: CLAUDE.md, ADRs 0001–0010 (all Accepted).

## 1. Shape of the system
- One published npm package: `@ninthwave-io/unused` (bin `unused`), TypeScript on Node ≥22 (ADR 0004).
- Internal module boundaries, enforced by lint — not npm package splits (solo-founder toil control; split later if ever needed):
  - `src/core` — language-agnostic: reference-graph IR, reachability + entrypoint partitioning, claim engine, hazard registry, cache.
  - `src/frontends/ts` — TS/JS frontend: discovery, parse (oxc-parser), module resolution (oxc-resolver + get-tsconfig), our own reference/symbol extraction, entrypoint detection, framework presets (ADR 0005 — no type checker in the analysis path). Emits IR only; core never imports frontend types (the ADR 0003 constraint, lint-enforced via dependency-cruiser per ADR 0007).
  - `src/reporters` — TTY, JSON, SARIF; all render from the claim schema, no analysis access.
  - `src/cli` — command surface, config loading, baseline, exit codes.
  - `src/mcp` — MCP server (stdio) over the same engine instance.
- Fixtures live at repo root `fixtures/<language>/<case>/` with `labels.yaml` ground truth (per ADR 0003, per-language layout from day one).

## 2. Data flow (one pass)
discover (workspaces, tsconfig, package.json, presets) → parse + bind → extract references + hazards → **IR graph** → partition entrypoints (production | test | config) → reachability per partition → claims (verdict + confidence via hazard rules) → reporters / MCP; file-level results cached (§5).

ADR 0013 extends this into a repository-level polyglot pass: language plugins
emit repository-relative graph fragments plus bounded claim annotations;
fragment mode does not allocate local reachability partitions, hazard closures,
claims, summaries, or predecessor maps. Convention plugins enrich the merged
graph, bridge plugins add cross-language edges, and only then does core compute
global reachability. Hazard and claim work retains fragment-specific policy and
provenance through shared graph indexes: disjoint fragments together scan each
owned file/symbol once instead of rescanning the merged graph per boundary.
TypeScript, Elixir, Rust, and Rustler/NIF are the proving set. The resumable delivery ledger is
`docs/delivery/polyglot-first-class.md`.
Implementation and fixture rules for these internal contracts live in
`docs/design/plugin-authoring.md`.
The measured Rust compiler/tooling boundary is
`docs/research/rust-frontend-stack-2026-07.md`.

## 3. Reference-graph IR (the language-agnostic contract)
- Nodes: `symbol`, `file`, `dependency`, `endpoint`, `entrypoint(kind: production|test|config)`.
- Edges: `references` (kind: `static` | `dynamic-resolved` | `runtime-resolved` | `safety-root` | `re-export` | `side-effect` | `hazard`), `exports`, `contains`, plus a reserved `consumes` edge for the endpoint→consumer join (tier 3). `runtime-resolved` is a literal runtime convention resolved to one exact symbol; `safety-root` is an explicit conservative edge from a bounded incomplete partition to an exact potentially reachable surface; `side-effect` keeps a file alive while binding no symbol — exports inside a side-effect-only module stay individually flaggable; `re-export` makes barrel chains (`export * from`) explicitly traversable by reachability and `why_alive`.
- **Provenance**: every edge and every hazard annotation carries the referencing site's span (file + span). Why-paths and report lines like "dynamic import nearby" render from stored provenance, never re-analysis.
- Hazard annotations attach to files/scopes: each cites a hazard class from the registry (§4).
- **Partition rule**: roots are production, test, or config. Code reachable from a config root is alive and never flagged in v1 — config-only liveness is not a claim; a future `config-only` verdict would be additive under the ADR 0006 enum policy.
- Frontends emit IR + hazards; core computes reachability and claims with zero language knowledge. This boundary is what makes Python/Elixir frontends additions, not rewrites.

## 4. False-positive strategy (the product's spine)
- **Hazard registry**: every mechanism where syntax cannot prove a reference absent is a registry entry: detection rule + scope of effect + confidence cap. The M1 set (red-teamed): string/computed imports, `require(expr)`, computed CJS exports (`module.exports[k]`), config-referenced files, framework conventions, checker-only type relationships (declaration merging, inference-only usage), `emitDecoratorMetadata`, conditional package.json `exports`/`imports` and `browser`-field remapping, JSX runtime dependency liveness (`jsxImportSource`), ambient/global `.d.ts` files, tsconfig project `references`. Unmodelled hazard ⇒ symbol stays alive, never a confident "unused" (core invariant).
- **The inverse rule matters equally**: references visible in AST type positions (annotations, `extends`/`implements`, `typeof`, `import type`) are real references, resolved statically — never blanket-downgraded, or recall collapses. Re-exports and side-effect imports are first-class IR edges (§3), not hazards.
- The PRD's **published assumption set has two parts, both shipped in code**: global analysis assumptions (a versioned constant rendered into the docs — tsconfig-governed resolution, entrypoints-as-complete-public-API, bundler aliases out of scope unless configured) and per-hazard downgrade clauses generated from the registry. Both render into one doc, minimising drift between docs and behaviour.
- `why_alive` and deletion-plan answers come from stored graph paths — no re-analysis for presentation (PRD §8 explainability bar, ADR 0012).
- Suppression comments and project/workspace rules annotate claims without removing graph nodes or edges. Config suppressions carry rule provenance in the machine contract (ADR 0012).
- File liveness is complete root reachability: an inbound edge from another unreachable file never makes a file alive.
- Mutation is a CLI orchestration layer over claims and deletion plans. Core analysis and MCP stay pure/read-only; the CLI applies an initial high-confidence set, then re-runs analysis once (ADR 0012).
- Boundary and production/config/test partition completeness is part of the
  machine contract. Partial facts must be bounded toward alive before global
  reachability; diagnostics are deterministic stderr, never JSON stdout.
- Internal frontend precision protocols may carry bounded structural facts
  without changing the shared IR. Such a protocol is a semantic no-op until a
  reviewed consumer is enabled; strict ownership, completeness, content-digest,
  and work-cap validation happens before any structural fact can influence a
  claim. Elixir protocol v2 is the first implementation. Its first reviewed
  consumers are two closed runtime-convention roles: compiler-joined MFA tuples
  and conventional literal-selector `__using__/1` dispatch (ADR 0011).

## 5. Performance strategy
- Discovery produces one gitignore-bounded inventory of sources, JSON configs,
  and package roots. Convention/config extraction consumes that inventory and
  must not recursively reopen the raw project filesystem.
- Per-file cache keyed by content hash + config hash + analyzer version: parse/extract results reused; graph rebuild is cheap relative to parse.
- Incremental mode = cache warm-hit path; no daemon, no watcher in v1.
- **Sequencing (red-team)**: the v1 milestones ship the cold path only; the warm-path cache lands after extractor correctness is proven on the corpus — a stale cache is false-positive surface, and correctness beats speed here too. Conscious debt, recorded.
- Targets per PRD §8 (cold <60s at ~5k modules, warm <10s) — measured from the first analyzer milestone (phasing M3) onwards, revisited with data.
- Repository-coordinate rebasing uses one context per fragment. POSIX-normalized
  paths are canonicalized across nodes, edges, hazards, claim inputs,
  contributions, and diagnostics; absolute or boundary-escaping paths are an
  internal refusal. Shared provenance sites retain object identity after
  rebasing. Nested language adapters explicitly consume their private local
  graph: every path and rewritten identity is validated before mutation, then
  nodes, edges, hazards, and sites transfer in place. The old-key node index
  resolves edge endpoints to their already-rebased node objects and is rebuilt
  only after edges change, avoiding an old-to-new identity table. A bounded set
  validates destination entrypoint ids because their target-bearing wire
  grammar is delimiter-based; file/symbol injectivity follows from exact local
  identity plus the canonical-path collision proof. Copy rebasing remains
  available for caller-owned graphs and never mutates its input.
- Opt-in `--performance` events include current RSS, heap, external/array-buffer
  memory, and current-process maximum RSS at every phase boundary. Counters are
  cumulative across fragments. Diagnostics remain stderr-only, so canonical
  JSON stdout is unchanged.

## 6. Plugin interface (sketched now, internal-only in v1)
Three plugin kinds, all internal modules behind interfaces in v1 (external loading deferred):
1. **Language frontends** — emit IR (ADR 0003).
2. **Evidence sources** — emit evidence records keyed to claim subjects (tiers 4–5): free local drivers (log files, user-credential remote queries) and paid hosted connectors both implement this same interface (ADR 0002).
3. **Framework presets** — entrypoint conventions + hazard rules (v1: `next`, `vite`).

## 7. MCP server
Stdio transport, read-only, no network; shares the engine and warm cache with the CLI; tool results are claim-schema projections (PRD §5).

## 8. ADRs
Accepted: 0001 license (MIT), 0002 free/paid credential boundary, 0003 language scope.
This phase (all drafted, Proposed pending the Phase 2 gate): 0004 CLI runtime (TS/Node ≥22), 0005 TS frontend (oxc stack, own extraction, no type checker), 0006 claim schema versioning + id, 0007 repo tooling (pnpm, single package, Biome, dependency-cruiser, Vitest), 0008 distribution (npm-only, provenance), 0009 test strategy (labelled corpus + precision gates).

## Open questions
- (accumulate during Phase 2)
