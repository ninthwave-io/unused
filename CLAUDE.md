# unused — liveness oracle for software

`unused` (unused.dev / unused.sh) tells engineering teams what code is truly unused — with graded confidence and provenance — so they, or their coding agents, can delete safely. **v1 is detection/analysis only: it never modifies code, never opens PRs.** Consumed via CLI report, `--json`, SARIF, CI gate mode, and an MCP server.

## The evidence ladder (claim tiers)
1. **Static reachability** — unused exports/files/dependencies via reference-graph analysis. Deterministic, local, fast.
2. **Test-only liveness** — code reachable only from test entrypoints (graph partitioned by production, test, and config roots; config-reachable code is never flagged); also surfaces the zombie tests and CI seconds wasted on them.
3. **Cross-boundary static** — API routes / tRPC procedures / GraphQL fields with no frontend consumers. Join keys: route paths, operationIds, procedure names, codegen'd clients. Multi-repo.
4. **Runtime evidence** — reachable but zero production traffic over a window. Sources: OTel, APM, plain access logs (nginx/Apache/CloudFront/ALB/API Gateway — the zero-integration beachhead). Tombstone mechanic: one-line marker; 90 days of silence upgrades the claim.
5. **Human-usage evidence** — served but untouched by users (PostHog/Amplitude/Mixpanel; event names are grep-able string literals, LLM assist only for fuzzy mapping). Claim is "deletable", buyer stays the engineer.

Every claim = subject + verdict + confidence + evidence list + provenance + time window.

## Non-negotiables
- Core is deterministic static analysis: no inference, no network. LLM calls only at the ambiguity margin (dynamic-reference triage), cheap models, capped retries, graceful "needs human" fallback — **never in the free tier's local path**.
- **The OSS CLI never phones home. Zero telemetry.** This is a trust feature.
- **False-positive rate is the top quality metric.** A golden-fixture FP regression blocks merge, no exceptions. When liveness is unprovable, say "alive" or lower confidence — never a confident wrong "unused".
- Free/paid line is the **credential boundary** (ADR 0002): **Free OSS = anything driven from the engineer's own environment with their own credentials** — single- and multi-repo local analysis, local log files, remote-source queries via the user's own credentials (e.g. CloudWatch through an AWS profile). **Paid hosted = the cloud platform** — managed connectors (we hold prod access so engineers don't need it), team dashboard, history/trends, hosted badge. Precise trust wording: the CLI makes network calls only to sources the user explicitly configures, with the user's credentials, never to us. Paid is deferred: documented, not built.

## v1 scope
**Multi-language positioning, TS/JS-first implementation** (ADR 0003): v1 ships TS/JS only (Knip's and Fallow's false-positive pain and TS/JS-only scope are the wedge); Python then Elixir next on the public roadmap; core is language-agnostic with per-language frontends. CLI `unused` with a beautiful terminal report + `--json` + SARIF; CI gate (fail on newly-added dead weight only); MCP server: `find_unused`, `why_alive(symbol)`, `usage_evidence(endpoint)`. Install: `npx @ninthwave-io/unused` (bin `unused`; npm org registration pending — founder action; unscoped `unused` dispute worth attempting in parallel). No curl installer in v1. Tier-3 endpoint extraction: schema contract in v1, implementation post-v1 stretch. Node ≥22. License MIT (ADR 0001). Growth artifact: shareable deletion report (deletable LOC, dead endpoints, CI seconds) + README badge.

## Founder constraints
Solo staff-level founder, 10–20 h/week, bootstrap (<£10k year-one). Optimise for resumability across short sessions, low ongoing toil, and false-positive rate above all other quality metrics.

## How we work
- **Fable orchestrates**: decomposes, writes task specs (context, files in scope, acceptance checklist), reviews, resolves conflicts, commits. Subagents implement.
- **Delegation policy**: Opus → reference graph, module resolution, cross-boundary matching, core-path reviews (`architect`, `core-implementer`, `reviewer`). Sonnet → everything else (`implementer`, `test-engineer`, `doc-writer`, `researcher`). Agent charters live in `.claude/agents/`.
- One task = one small reviewable diff, with an explicit acceptance checklist in the delegation prompt.
- **Docs before code; plan before docs.** Phases are gated by founder approval (Phases 1, 2, 3, and each implementation milestone). Never burn a gate for momentum.
- **Decisions become ADRs** in `docs/adr/NNNN-title.md`. Reversals get a superseding ADR, never an edit.
- **Before every commit**: typecheck, lint, unit tests, golden-fixture suite all green. A reviewer subagent reviews every diff; core-path diffs get the Opus reviewer. Never commit red.
- **Git**: trunk-based, short-lived branches per task, conventional commits with task ID, atomic commits, tag milestone completions.
- **Ask, don't assume**: package naming, license, Node floor, repo/org naming, pricing — founder decisions.
- **Study the incumbents, never copy them** (founder directive, Phase 3 gate): Knip (ISC) and Fallow (MIT) are reference material — mine their test suites and FP issue trackers to enumerate hazard scenarios, re-derive our own fixtures from scratch, and run differential comparisons against Knip on smoke repos (disagreements get triaged). Never copy fixture or source files; if anything is ever directly adapted, carry the upstream license attribution.
- **Benchmark performance from the first analyzer milestone** (founder directive, Phase 3 gate): timed cold runs on pinned repos, results committed to the repo, Knip on the same repo as the reference point; every milestone gate reports the trajectory. Early-pivot checkpoint at the M4 gate: cold runs >3× Knip, or clearly off the PRD §8 budget, opens the ADR 0004 reversal (native/Rust hot paths) immediately rather than post-v1.

## Resuming a session
Read this file, then `docs/progress.md` (current phase, done, next, open questions). ADRs are authoritative on settled decisions. Assume this session may be the last before a cold restart: update `progress.md` before ending any work block.
