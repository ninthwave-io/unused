# PRD — unused v1

Status: APPROVED at the Phase 1 gate (2026-07-18); amended same day to incorporate gate decisions (ADRs 0001–0003).

## 1. Product summary

`unused` is a local-first CLI for TS/JS repositories. The positioning is multi-language (ADR 0003): v1 implements TS/JS only, but the core — reference graph, claim engine, reporters — is designed language-agnostic, with each language landing as a frontend rather than a rewrite. It parses the repo, builds a reference graph across modules, partitions entrypoints into production and test roots, and emits graded, explainable claims about code that is provably or probably dead. It never phones home. Analysis is read-only by default; ADR 0012 adds an explicit, conservative `--fix` workflow which changes the working tree but never commits for the user. Trust is earned by being right before being aggressive.

The claims it emits sit on an evidence ladder (defined in `CLAUDE.md`, not restated here) running from static reachability through test-only liveness, single-repo cross-boundary matching, and — as reserved-but-unimplemented contracts in v1 — runtime and human-usage evidence. Each claim carries a subject, a verdict, a confidence grade, an evidence list, and provenance, so a human or an agent can inspect *why* something is flagged before acting on it.

Three consumption surfaces share one engine: a human-facing terminal report, machine-facing `--json`/SARIF output for CI and static-analysis tooling, and an MCP server for coding agents. All three read from the same claim schema (Section 4), so there is exactly one place where "unused" is defined.

## 2. User stories

**T1 — static reachability.** As a platform engineer inheriting a service with years of accreted exports, I run `npx @ninthwave-io/unused` against the repo and get a ranked list of unused exports, files, and dependencies. Each finding carries a confidence grade and a one-line "why" so I don't have to re-derive the reasoning myself before I trust it enough to delete. This is the entry point for most users: zero configuration, immediate signal, no server to stand up.

**T2 — test-only liveness.** As the same engineer, I've been burned before by tools that say "unused" while a test file quietly imports the code, so the deletion breaks CI. `unused` instead shows me code whose only inbound references originate from test entrypoints — the zombie code and the zombie tests keeping it alive — plus the CI seconds those tests cost. That reframes the decision: it's not "is this used", it's "is this used by anything that matters", which is the question I actually had.

**T3 — single-repo cross-boundary.** As a platform engineer owning an API service, I want to know which routes, tRPC procedures, or GraphQL fields have no consumer anywhere in *this* repo's frontend. `unused` matches route paths, `operationId`s, procedure names, and codegen'd client calls within the single repo to answer that. It cannot see a consumer that lives in a different repository in v1 — cross-repo correlation arrives post-v1: free when driven locally across repos the user has checked out (ADR 0002), paid when performed by the hosted platform's managed connectors. **Feasibility note (confirmed at the Phase 1 gate):** the endpoint claim contract ships in the v1 schema, but T3 extraction is post-v1, starting with a single framework (Next.js API routes) — one extractor per protocol (HTTP, tRPC, GraphQL) is too much for the v1 milestone budget.

**CI story.** As the pipeline running on every pull request, I need to fail the build when a PR *adds* new dead weight, without failing on the pre-existing debt the team hasn't triaged yet — a hard "fail everything" gate on a codebase with years of history would be ignored within a week. `unused check` compares the current run's claims against a committed baseline and exits non-zero only for claims that are new since that baseline, at or above a configured confidence threshold.

**Agent story.** As a coding agent tasked with cleaning up a module, I call `find_unused` over MCP, filter to `confidence: high` claims I'm permitted to act on autonomously, and for anything I'm about to touch I call `why_alive` first to get the actual reference path — because a stale or partially-scoped analysis is worse than no analysis when I'm the one holding the delete key. The MCP surface exists specifically because agents need structured, thresholdable answers, not a TTY report to parse.

**Tiers 4–5 (runtime and human-usage evidence).** These appear in v1 only as documented, stable contracts — evidence `type` values reserved in the schema, an MCP tool shape (`usage_evidence`) defined but not backed by a real connector. No OTel, APM, log, or product-analytics integration ships in v1. This exists so that when evidence sources arrive — locally driven in free OSS (local log files, user-credentialed remote queries), managed connectors in paid hosted (ADR 0002) — they extend the existing schema rather than requiring a breaking v2.

## 3. CLI surface

| Command | Purpose | Exit behaviour |
|---|---|---|
| `unused` | Analyse the repo and print the TTY report — the product's face. | Always exits 0 on a successful analysis; findings do not affect the exit code. Report mode is informational, not a gate. |
| `unused check` | CI gate: compares findings against a committed baseline, fails only on new dead weight. | 0 on pass, 1 on gate failure. |
| `unused baseline` | Write or update the baseline (proposal: per-workspace `.unused/baseline.jsonl`, id-sorted for minimal diff churn, committed). Prints a summary of every claim it blesses so PR review sees what was waved through. | 0 on success. |
| `unused why <symbol\|file>` | Reference-path explanation for a single symbol or file — the same engine that backs the MCP `why_alive` tool. | 0 on success. |
| `unused why --delete <symbol\|file\|dependency>` | Read-only counterfactual deletion plan: required re-export edits and claims made newly dead. | 0 on success. |
| `unused mcp` | Start the MCP server (stdio) over the same engine. | Runs until the client disconnects; 0 on clean shutdown. |
| `unused report [--md\|--html]` | Render the shareable deletion report from the last analysis (docs/design/report-and-badge.md). | 0 on success. |
| `unused badge` | Write the README badge artifact (shields.io endpoint JSON or SVG). | 0 on success. |

`unused --fix` applies reviewable working-tree edits for unsuppressed, high-confidence `unused` exports and dependencies. `--fix-type` narrows the mutation kinds. File removal requires both `--fix-type files` and `--allow-remove-files`. The tool never commits, stages, installs, updates lockfiles, or recursively fixes consequences discovered after the initial analysis; it re-analyses and reports them instead (ADR 0012).

Flags apply across commands where relevant: `--json` (emit the claim-schema JSON instead of, or alongside, the TTY report), `--sarif <file>` (write a SARIF log to the given path), `--filter <kind>` (restrict to one or more subject kinds), `--min-confidence <level>` (drop claims below `high`/`medium`/`low`), `--config <path>` (override config discovery), `--cwd <dir>` (analyse a directory other than the current one), `--no-color` (disable ANSI output, also implied by a non-TTY stdout or `NO_COLOR`).

**Exit-code contract** (stable from v1 — this is a promise CI pipelines and scripts can be written against without expecting it to move):
- `0` — success: report printed, or gate passed.
- `1` — gate failure: `unused check` found new dead weight at or above the configured threshold.
- `2` — analysis error: the tool ran but could not complete analysis (e.g. unparseable source, tsconfig resolution failure).
- `3` — config/usage error: bad flags, malformed config file, invalid `--min-confidence` value.

The separation of 1 (a legitimate finding) from 2/3 (the tool itself is broken or misused) matters for CI scripting: a pipeline should treat exit 1 as "review the diff" and exit 2/3 as "the check itself is broken, page someone."

**Partial-failure semantics**: an individual unparseable file is skipped with a prominent warning and treated as though it might reference anything — claims that depend on that file's silence are downgraded, never confidently emitted — and the exit code stays 0. Exit 2 is reserved for analysis that cannot proceed at all (e.g. unresolvable tsconfig, unreadable project root). A missing baseline in `unused check` is a usage error (exit 3) with a message telling the user to run `unused baseline`, not a silent pass.

**Baseline workflow**: baselines are regenerated on the main branch only — regenerating on a feature branch masks the very regressions the gate exists to catch; the docs and the `unused baseline` output both say so.

## 4. Claim schema (JSON)

The `--json` output is the canonical machine representation; SARIF and the MCP tools are projections of the same underlying claims.

**Top level:**
```
{ schemaVersion, tool: {name, version}, run: {root, commit?, configHash, startedAt, durationMs, boundaries: [{status, pluginId, boundaryId, language, fileCount, workspaceCount}]}, claims: [], summary: {byKind, byConfidence, estDeletableLoc} }
```
`run.commit` is optional because not every analysis happens inside a git repo with a resolvable HEAD (e.g. a shallow CI checkout or a plain directory). `run.configHash` lets a consumer detect that two runs aren't comparable because the config changed underneath them — relevant for baseline diffing in `unused check`. `run.boundaries` is the deterministic record of completed language analyses, so a successful polyglot run proves which detected TypeScript, Elixir, Rust, or future boundaries actually contributed. `summary` exists so a TTY report or a chat-posted digest can render totals without walking the full `claims` array.

**Claim:**
```
{ id, language, subject: { kind: export|file|dependency|endpoint|test, name, protocol?, loc: {file, span, package?} }, verdict: unused|test-only|unconsumed-endpoint, confidence: high|medium|low, evidence: [{ type, detail, source, window? }], provenance: { analyzer, version, generatedAt }, suppression?: { reason, source?, pattern? }, deletionPlan?: { stages, requiredEdits } }
```
`language` is the explicit open language id (`ts`, `ex`, `rs`, or a future frontend id), so consumers never need to infer attribution from file extensions or analyzer names. `id` is a stable hash of `(kind, language, name, file)` — it deliberately excludes line numbers so a claim survives the subject moving within its file, which is what makes baseline diffing in `unused check` meaningful across commits rather than noisy on every reformat. TypeScript retains its historical empty canonical language slot for id compatibility while rendering `language: "ts"`; Elixir, Rust, and future frontends use their explicit language id in identity. It is stable to in-file moves but **not** to cross-file moves: a moved symbol reads as one resolved claim plus one new claim — documented behaviour, not a bug. Baselines stamp the analyzer version; on a version mismatch `unused check` warns and recommends re-baselining rather than hard-failing, because an analyzer upgrade must never paint the whole repo as "new dead weight". The exact hash algorithm and its cross-version stability guarantee are fixed in the Phase 2 claim-schema-versioning ADR.

`endpoint` subjects carry `protocol` (`http`, `trpc`, `graphql`) and, for HTTP, the method as part of identity — `GET /users` and `POST /users` are distinct claims. `subject.loc.package` is optional and names the workspace package in a monorepo; a future `repo` qualifier is reserved for multi-repo claims — free local multi-repo and hosted alike (ADR 0002) — so the shape extends without breaking.

`evidence[].type` is drawn from the same five-tier vocabulary as the evidence ladder (`static-reachability`, `test-only`, `cross-boundary`, `runtime`, `human-usage`); the latter two are reserved for the hosted correlation engine and are never emitted by the v1 OSS analyzer. The verdict enum likewise pre-reserves `no-runtime-traffic` (tier 4) and `no-user-engagement` (tier 5) — closed today, future-proof for consumers that switch on `verdict`.

**Verdict vocabulary is bound to subject kind** (enforced rule, not convention): `export`, `file`, and `dependency` subjects take `unused` (no production or test references) or `test-only` (only test-entrypoint references); `endpoint` subjects always take `unconsumed-endpoint`; `test` subjects take `test-only` (a zombie test — one whose only purpose is exercising code that is itself test-only or dead). A claim pairing a kind with a verdict outside this mapping is invalid.

**Suppression** is structured: a claim suppressed via `/* unused:ignore <reason> */` or a project/workspace suppression rule carries `suppression: { reason, source?, pattern? }` — presence of the object means suppressed. Suppression never removes reference-graph evidence. Suppressed claims remain in JSON/SARIF, are hidden from the default terminal report, and are excluded from gates; `--show-suppressed` displays them. Reasons are mandatory and stale config rules warn (ADR 0012).

**Deletion plans** are optional, additive, counterfactual data. They contain deterministic consequence stages and required source edits, but are not claims and never alter summaries, baselines, gates, badges, or confidence. The detailed form is returned by `unused why --delete`; the report may include compact summaries for its highest-value findings.

**Confidence semantics** are a contract, not a UX nicety, because agents threshold on them programmatically:
- `high` — zero false positives under a **published, enumerated assumption set**: module resolution follows tsconfig/package.json (bundler-only aliases such as webpack `resolve.alias` are out of scope unless configured); declared entrypoints are the complete public API (a library's `exports` map counts as entrypoints, so public API surface is never flagged); and every modelled dynamic-reference hazard class (string/computed imports, `require` with expressions, config-referenced files, framework conventions covered by an active preset) forces a downgrade to `medium`. `high` means "safe to act without re-deriving the reference graph" — dynamic context the analyzer cannot see remains the caller's responsibility, and the assumption set ships verbatim in the docs.
- `medium` — statically unused, but a known dynamic-reference hazard exists nearby (string-based imports, reflection, config-driven wiring) that the analyzer cannot rule out with certainty.
- `low` — a candidate. Needs human confirmation, or a tombstone window (see the evidence-ladder runtime tier in `CLAUDE.md`) to mature.

**Worked example.** An export with no inbound reference from any production entrypoint, no dynamic-reference hazard nearby:
```json
{
  "schemaVersion": "1.3.0",
  "tool": { "name": "unused", "version": "0.1.0" },
  "run": {
    "root": "/repo",
    "commit": "3f1a9c2",
    "configHash": "9e1b6f2a9d4c",
    "startedAt": "2026-07-18T09:12:03.000Z",
    "durationMs": 4210,
    "boundaries": [
      {
        "status": "complete",
        "pluginId": "language:typescript",
        "boundaryId": "ts:.",
        "language": "ts",
        "fileCount": 1284,
        "workspaceCount": 1
      }
    ]
  },
  "claims": [
    {
      "id": "exp_7c1a4e2f9b0d3c6a",
      "language": "ts",
      "subject": {
        "kind": "export",
        "name": "formatCurrency",
        "loc": { "file": "src/utils/currency.ts", "span": [12, 24] }
      },
      "verdict": "unused",
      "confidence": "high",
      "evidence": [
        {
          "type": "static-reachability",
          "detail": "0 inbound references to `formatCurrency` from any production or test entrypoint in the reference graph.",
          "source": "reference-graph"
        }
      ],
      "provenance": {
        "analyzer": "ts-reference-graph",
        "version": "0.1.0",
        "generatedAt": "2026-07-18T09:12:07.210Z"
      }
    }
  ],
  "summary": {
    "byKind": { "export": 1, "file": 0, "dependency": 0, "endpoint": 0, "test": 0 },
    "byConfidence": { "high": 1, "medium": 0, "low": 0 },
    "estDeletableLoc": 13
  }
}
```
`configHash`, `id`, and `commit` values above are illustrative — the outline fixes their presence and role in the schema, not the exact hash algorithm, which is a Phase 2/3 implementation decision.

**SARIF mapping.** One rule per claim kind: `unused/export`, `unused/file`, `unused/dependency`, `unused/endpoint`, `unused/test-only`. `level` is `warning` for `high` confidence and `note` for `medium` or `low`. Confidence, the evidence list, and the "why" text all travel in the result's `properties` bag so a SARIF-consuming tool (GitHub code scanning, an IDE plugin) can surface them without a second query. The claim `id` maps to `partialFingerprints.unusedClaimId/v1` so code-scanning alert tracking stays stable across commits; `relatedLocations` is reserved for future producer↔consumer pairs on cross-boundary claims. Rule IDs are a stable contract from v1. The same finding as above, as a SARIF result:
```json
{
  "version": "2.1.0",
  "$schema": "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
  "runs": [
    {
      "tool": {
        "driver": {
          "name": "unused",
          "version": "0.1.0",
          "rules": [
            { "id": "unused/export", "shortDescription": { "text": "Unused exported symbol" } }
          ]
        }
      },
      "results": [
        {
          "ruleId": "unused/export",
          "level": "warning",
          "message": { "text": "Export `formatCurrency` is unreachable from any production entrypoint." },
          "locations": [
            {
              "physicalLocation": {
                "artifactLocation": { "uri": "src/utils/currency.ts" },
                "region": { "startLine": 12, "endLine": 24 }
              }
            }
          ],
          "partialFingerprints": { "unusedClaimId/v1": "exp_7c1a4e2f9b0d3c6a" },
          "properties": {
            "confidence": "high",
            "evidence": [
              {
                "type": "static-reachability",
                "detail": "0 inbound references to `formatCurrency` from any production or test entrypoint in the reference graph.",
                "source": "reference-graph"
              }
            ],
            "why": "No production or test entrypoint reaches this export."
          }
        }
      ]
    }
  ]
}
```

## 5. MCP server

Transport is stdio; the server is read-only and makes no network calls, matching the zero-telemetry, no-network-in-the-local-path constraint that applies to the rest of the OSS CLI. It ships inside the CLI package and is invoked as `unused mcp` — there is no separate install.

- **`find_unused({ kinds?, minConfidence?, paths? })  →  { claims }`** — returns claims in the same schema as `--json`, filtered by kind, confidence floor, and path scope. This is the bulk-query tool: an agent asks "what's dead in this directory" and gets back a thresholdable list.
- **`why_alive({ symbol })  →  { alive, paths: [entrypoint → … → symbol], entrypointKind: production|test|config }`** — the tool that differentiates `unused` from a static report generator. It must answer for *any* symbol, not only ones already flagged dead, because the actual agent workflow is "I'm about to touch this — is it safe?" rather than "show me only what you've already decided is dead." Returning the full reference path, and which kind of entrypoint it terminates at, is what lets an agent (or a human) distinguish "alive via production code" from "alive only because a test imports it" without re-running the whole analysis.
- **`usage_evidence({ endpoint })  →  { evidence: [] }`** — evidence sources are populated two ways under the credential boundary (ADR 0002): locally-driven sources in the free OSS tier (local log files, remote-source queries via the user's own credentials) land post-M6 on the free roadmap; managed cloud connectors are paid hosted. In v1, the tool returns whatever static and test-only evidence exists for the endpoint; source slots that aren't configured respond with an explicit "not configured" rather than an empty array.

## 6. Configuration

The zero-config path is the default path: `unused` auto-detects `package.json` entrypoints, workspace layout (npm, pnpm, yarn, and bun workspaces), `tsconfig.json`, and common test-file patterns (`*.test.ts`, `*.spec.ts`, `__tests__/`) without a config file present. This matters because most first runs happen before anyone has decided the tool is worth configuring — the false-positive bar (Section 8) has to hold even on a naive, unconfigured run. One explicit exclusion: **Yarn Plug'n'Play is unsupported in v1** — PnP is detected and analysis stops with a clear unsupported message (exit 2) rather than mis-resolving; a silent wrong answer is worse than a refusal.

Where auto-detection is insufficient, `unused.config.jsonc` overrides or extends it (ADR 0010). Fields: `entry` (additional roots, optionally seeded by a framework preset), `project` (files eligible for claims without erasing graph evidence), `suppressions` (structured file-pattern + claim-kind + reason rules), `ignoreDependencies` (package names excluded from dependency-unused checks), `workspaces` (per-workspace overrides), and `gate: { threshold }` (the confidence floor `unused check` gates on; **default `high`**). Discovery respects applicable `.gitignore` rules by default; `--no-gitignore` opts out. The pre-release `ignore` field's graph-invisibility behavior is removed by ADR 0012.

Framework presets bundle two things per framework (v1 ships one or two — `next` and `vite` — with the rest arriving through the community-contribution interface; five hand-built presets do not fit the v1 budget): the entrypoint conventions (e.g. Next's `pages/`/`app/` file-based routing counts as implicit entrypoints even though nothing imports those files directly) and the implicit-reference rules that would otherwise show up as false positives. Presets are designed to be community-contributable — this is the mechanism by which the tool keeps pace with an ecosystem that invents new "magic" faster than one founder can track it.

Suppression is hybrid. `/* unused:ignore <reason> */` immediately above a declaration remains the precise escape hatch; project/workspace rules handle file-pattern policy. Every rule names explicit claim kinds and a mandatory reason. Suppressed claims remain in machine output and suppressed totals, while default human output and gates omit them.

```jsonc
// unused.config.jsonc
{
  // Next.js preset seeds file-based route entrypoints; these add to it.
  "entry": ["src/index.ts", "src/pages/**/*.tsx"],
  "project": ["src/**/*.{ts,tsx}", "!src/legacy/**"],
  "suppressions": [
    {
      "files": ["src/generated/**"],
      "kinds": ["file"],
      "reason": "Generated source is replaced by the schema pipeline"
    }
  ],
  "ignoreDependencies": ["@types/node"],
  "workspaces": {
    "packages/api": {
      "entry": ["src/server.ts"]
    }
  },
  "gate": {
    "threshold": "medium"
  }
}
```
This config is consistent with the worked claim above: `src/utils/currency.ts` falls under `project` (`src/**/*.{ts,tsx}`), is not excluded by its negated project pattern, and is not itself an `entry` file — so it is claimable, and the `formatCurrency` export inside it is a legitimate candidate for the reference graph to flag.

## 7. Non-goals (v1)

No automatic commits, staging, package-manager invocation, lockfile editing, PR opening, or MCP mutation — `--fix` changes only its explicitly eligible working-tree targets under ADR 0012. No hosted service, no multi-repo correlation, no managed telemetry/log/analytics connectors — those are the paid product under the credential boundary (ADR 0002: paid is managed connectors, team dashboard, and history/trends; locally-driven sources — log files, remote queries via the user's own credentials — are free-tier roadmap, not paid). No languages beyond TS/JS in v1 — TS/JS is the wedge because that's where Knip's false-positive pain lives, and broadening precision-critical scope before nailing one ecosystem would dilute the core bet; Python, then Elixir, are named on the public roadmap (ADR 0003), and the core must not couple to the TypeScript compiler API so those frontends can land without a rewrite. [Vulture](https://github.com/jendrikseipp/vulture) is a named research comparator when Python work begins. No IDE extension and no watch mode — v1 is a CLI artefact consumed by humans, CI, and agents, not a long-running editor integration. No telemetry, ever, in the OSS CLI, under any circumstance — this is listed as a non-goal deliberately, not just a privacy nicety, because "the OSS CLI never phones home" is a trust feature the whole adoption strategy leans on. No LLM calls in the local analysis path — the deterministic core stays deterministic; any future LLM-assisted triage (e.g. for dynamic-reference ambiguity) is capped, cheap-model, and explicitly out of the free tier's local path per `CLAUDE.md`.

## 8. Quality bar (measurable)

False positives are the top quality metric, above recall, above speed, above feature breadth — a single confidently-wrong "unused" verdict is what destroys the trust the whole product depends on. That priority is enforced mechanically, not just stated:

- **Golden-fixture corpus**, built from milestone 1 (M1) onward and grown forever: zero false positives among `high`-confidence claims on the corpus is a hard CI gate — a regression here blocks merge, no exceptions, matching the non-negotiable in `CLAUDE.md`. Overall corpus precision (across all confidence levels) is tracked to a ≥95% target. Recall is measured and reported every milestone but is not itself gated in M1 — a tool that under-reports is annoying; a tool that over-reports is dangerous, and M1's gate reflects that asymmetry.
- **Real-repo smoke testing**: 2–3 large OSS repositories are analysed per milestone, and every finding is hand-triaged by a human, not sampled. No `high`-confidence false positive is allowed to survive a milestone gate — this is the check against the golden-fixture corpus becoming a closed, self-confirming loop.
- **Performance targets** (provisional until the M1 baseline exists): cold analysis of a roughly 5,000-module repository completes in under 60 seconds on a developer laptop; a warm or incremental run completes in under 10 seconds. These numbers are targets to validate against real M1 data, not yet measured commitments.
- **Explainability**: every claim renders its one-line "why" from data already captured at analysis time — no re-analysis, no second pass over the repo, is required to answer "why is this flagged." This is what makes `unused why` and the MCP `why_alive` tool fast enough to call interactively rather than as a batch job.

## Open questions

- Claim `id` hash and schema semver policy — resolved by ADR 0006 (Proposed): SHA-256 subject-tuple id with `idVersion`, closed verdict/kind enums with reserved values, open evidence-type enum. Approve at the Phase 2 gate.
- Config format — resolved by ADR 0010 (Proposed): JSONC only in v1, JSON Schema shipped for editor support, no user-code execution. Approve at the Phase 2 gate.
- Baseline format — per-workspace id-sorted `.unused/baseline.jsonl` stamped with analyzer/id/schema versions (ADR 0006); validated at the CI-gate milestone (docs/phasing.md M7).

### Decided at the Phase 1 gate (2026-07-18)

- Package name: `@ninthwave-io/unused` (bin `unused`), matching the ninthwave-io GitHub org.
- Node version floor: ≥22.
- `usage_evidence`: ships in v1 OSS; unconfigured source slots respond with an explicit "not configured".
- Free/paid boundary: the credential boundary (ADR 0002) — free is anything driven from the engineer's own environment with their own credentials; paid is managed cloud connectors, dashboard, and history.
- Tier-3 (endpoint) extraction: confirmed descoped to post-v1, one framework first.
- `curl -fsSL unused.sh | sh` installer: confirmed dropped from v1.
- License: MIT (ADR 0001).
