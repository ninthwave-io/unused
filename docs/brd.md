# BRD — unused

Status: APPROVED at the Phase 1 gate (2026-07-18); amended same day to incorporate gate decisions (ADRs 0001–0003).

## 1. Problem and thesis

AI has made writing code cheap. It has not made *keeping* code cheap — every line retained after it stops earning its keep is a tax paid repeatedly: on human and agent comprehension (context windows are finite, and dead code crowds out what an agent needs to reason about), on CI minutes, on security and audit surface, on dependency upgrades, and on migrations that have to route around code nobody can prove is safe to touch.

Tooling to find unused code already exists — depcheck, ts-prune, unimported, and now Knip (§3) — yet dead code keeps accumulating in real codebases. The reason isn't tooling absence, it's untrustworthiness: existing tools give binary verdicts, "unused" or not, with no confidence grading and no explanation. When they're wrong — every one of them has open false-positive issues stretching back years (§3) — nobody trusts the next verdict either, so engineers stop running the tool, or ignore its output. Deletion is also structurally low-status work: no visible feature, downside risk if wrong, invisible upside ("nothing broke"). For deletion to happen at scale it has to be cheap to check and defensible to act on.

The thesis: the missing piece isn't a better static analyser, it's a **liveness oracle** — a system that attaches graded confidence, an evidence list, and provenance to every claim, in a form a human or a coding agent can act on without re-deriving trust each time. A claim reads like "no static references since commit X; zero production traffic in 90 days" rather than a bare "unused". That structure, not a smarter algorithm, is what turns a verdict into evidence.

Timing matters for two independent reasons: agents generate more code, faster, than humans did, which accelerates the accumulation problem this addresses; and agents also *consume* deletion targets directly, so the interface has to be machine-readable (MCP, JSON, SARIF) with confidence values they can threshold on programmatically, not just a report a human reads.

## 2. Target user

The primary user is a staff or senior engineer, or a platform/infrastructure team, at a TS/JS-heavy organisation in roughly the 10–500 engineer range. Below that range engineers usually hold the "what's dead" knowledge in their heads; above it, dead-code correlation becomes a multi-team, multi-repo problem this product doesn't solve at the entry point — that's where the local multi-repo and hosted capabilities come in (§4). The range is chosen for where the pain is acute and the buyer has autonomy: engineers here can install a CLI without a procurement process, but the codebase is large enough that manual archaeology has real cost.

The secondary consumer is not human: coding agents acting on claims via MCP, JSON, and SARIF. This is a design constraint, not a market-fashion choice — agents are first-class consumers of `why_alive` and `usage_evidence` (§1).

Buyer = engineer, not a manager or a security team; adoption is bottom-up and OSS-led, with deliberately no top-down sales motion. Consequence: there is no sales conversation to compensate for a bad first run. The tool has to earn trust in a single invocation, because that's the only pitch it gets.

## 3. Competitive landscape

Facts below are from the July 2026 research pass (`docs/research/competitive-landscape-2026-07.md`), verified live against npm/PyPI/crates.io/GitHub APIs on 2026-07-18.

### The pre-Knip generation is dead

depcheck, ts-prune, and unimported are all formally archived on GitHub, each carries a README notice redirecting to Knip, and none has a first-party MCP server. depcheck's last commit (2025-02-27) was the deprecation notice itself; it's frozen on 1.4.7 with open false positives, e.g. a 2024 detection issue ([#885](https://github.com/depcheck/depcheck/issues/885)) and a Vite-alias issue ([#898](https://github.com/depcheck/depcheck/issues/898)). ts-prune, archived 2025-09-19, never shipped JSON output ([#150](https://github.com/nadeesha/ts-prune/issues/150)), never supported dynamic imports ([#29](https://github.com/nadeesha/ts-prune/issues/29)), and once flagged an entire codebase as unused ([#151](https://github.com/nadeesha/ts-prune/issues/151)). unimported, archived earliest (2024-03-10, 18 issues mass-closed the same day), had an "all files unimported" bug recurring across three versions ([#59](https://github.com/smeijer/unimported/issues/59), [#64](https://github.com/smeijer/unimported/issues/64), [#71](https://github.com/smeijer/unimported/issues/71)). This generation isn't a threat; it's a cautionary tale about the exact failure mode — unreliable verdicts, then abandonment — this product exists to avoid repeating.

### Knip — the incumbent to beat on adoption, and on trust

Knip ([github.com/webpro-nl/knip](https://github.com/webpro-nl/knip)) is the standard: v6.27.0 as of 2026-07-15, 610 versions shipped total, a release roughly every 2–3 days, 43M npm downloads/month, 11,762 GitHub stars. Triage is aggressive, not neglectful — 410 commits, 101 issues opened/110 closed in the last three months, only 6 open today. That cadence is a real moat.

Two facts cut against it. First, maintenance is concentrated: 83% of recent commits come from a single maintainer (Lars Kappert), and funding is thin — Open Collective shows $4,430 total raised and roughly $520/month gross despite sponsor logos from Vercel, Sourcegraph, Datadog, and CodeRabbit. Genuine bus-factor risk, though one `unused` shares too (§6). Second, and more load-bearing here: Knip has recurring, documented false-positive pain in exactly the areas that matter most — dynamic imports and lazy loading ([#556](https://github.com/webpro-nl/knip/issues/556), [#839](https://github.com/webpro-nl/knip/issues/839)), config/entry-point resolution (Vite's babel field, [#1723](https://github.com/webpro-nl/knip/issues/1723), filed May 2026, still recurring), framework "magic" (a Vue SFC namespace-import issue took 4 months and 12 comments to close, [#740](https://github.com/webpro-nl/knip/issues/740); an Nx+Next.js Pages Router regression produced 361 false positives in Jan–Feb 2026, [#1466](https://github.com/webpro-nl/knip/issues/1466)), and monorepo resolution (a workspace-subpackage regression filed 2026-03-26, [#1642](https://github.com/webpro-nl/knip/issues/1642); pnpm catalog support took 8 months to land, [#987](https://github.com/webpro-nl/knip/issues/987); a pnpm-dlx-plus-catalog issue is still open as of 2026-07-15, [#1885](https://github.com/webpro-nl/knip/issues/1885)). A generic FP issue ([#589](https://github.com/webpro-nl/knip/issues/589)) and a 4.5-month-open `exports`-resolution issue ([#853](https://github.com/webpro-nl/knip/issues/853)) round this out. Individual issues close reasonably fast; the *classes* of failure — framework magic, monorepo resolution — recur across years and major versions. That recurrence, not any single bug, is the wedge: the same binary-verdict, static-only limitation, surfacing again each time.

### Fallow — the closest competitor, full stop

Fallow ([fallow-rs/fallow](https://github.com/fallow-rs/fallow), created 2026-03-17, already 4,130 stars) is not a distant threat — it is doing substantially the same thing this product plans to do, and it is ahead on ship date and momentum. It's a Rust/OxC static analyser for TS/JS with a paid runtime tier ingesting V8/Istanbul production coverage for "cold-path deletion evidence" — this product's static+runtime fusion thesis, already shipped — plus its own MCP server (`fallow-mcp`) and public speed benchmarks against Knip. It has a team and momentum; this product has a solo founder at 10–20 h/week (§5). That asymmetry is named plainly, not softened (§6).

The honest differentiation, stated without inflating it: (a) the runtime tier here uses zero-integration production signals teams already have — access logs, OTel, APM — rather than in-process V8/Istanbul coverage instrumentation, which costs runtime performance and the courage to enable an instrumentation SDK in production; (b) graded confidence + evidence + provenance is a product-level guarantee on every claim here, not a bolt-on feature; (c) test-only liveness (production-dead-but-test-alive code, and the CI seconds wasted on it) is a distinct, first-class tier, not folded into a generic "unused" bucket; (d) trust stance — deterministic core, zero telemetry, "alive when uncertain" as policy, not marketing copy. None of this is a proven advantage yet; it's the bet, and Fallow could close any of it.

### necro — evidence this framing is convergent, not proprietary

necro ([manehorizons/necro](https://github.com/manehorizons/necro), npm, ~1 star, first published June 2026) is tiny and unproven, but it independently arrived at nearly this product's evidence-ladder design: three confidence tiers, per-finding evidence chains, and an explicit "test-only" liveness verdict. One data point isn't a trend, but it signals that graded-confidence, test-aware liveness is an idea whose time has come — which cuts against treating this framing as a defensible moat on its own.

### MCP is table stakes

At least six tools already expose dead-code functionality over MCP — Knip (`@knip/mcp`, though adoption is under 0.1% of Knip's core install base), necro, Fallow, Skylos ([duriantaco/skylos](https://github.com/duriantaco/skylos)), repowise, and assorted zero-star clones. Shipping an MCP server is necessary and unremarkable. The differentiator is the quality of the `why_alive` answer it returns, not the fact of the protocol.

### The language axis

Knip and Fallow are both TS/JS-only. The per-language tools in the landscape — vulture (Python), deptry (Python), cargo-machete (Rust) — are single-language and binary-verdict, each scoped to its own ecosystem with no shared claim format across them. `unused` positions itself differently: one oracle, one claim schema, graded confidence, multi-language — v1 ships TS/JS, with Python then Elixir next on the public roadmap (ADR 0003). Said plainly: that positioning is roadmap intent, not shipped capability.

### The verified-empty niche

No tool found anywhere correlates OTel/APM/access-log production traffic with liveness claims — checked via multiple targeted negative searches, not just absence of evidence. Fallow and Sentry's Reaper ([getsentry/Reaper-iOS](https://github.com/getsentry/Reaper-iOS), OSS since 2025-07-08, the credibility anchor for runtime-instrumented deletion via its Duolingo case study) both use in-process coverage/instrumentation, not trace or log correlation, and Reaper is mobile-only besides. The zero-integration runtime-evidence beachhead — tier 4, built from signals teams already have running — is genuinely open right now, and it's the tier most exposed to Fallow reaching it first (§6).

### Python/Rust adjacents

vulture ([jendrikseipp/vulture](https://github.com/jendrikseipp/vulture), active, v2.16, confidence-scored, whitelist-based FP suppression), deptry ([osprey-oss/deptry](https://github.com/osprey-oss/deptry), recently moved from a personal account to a multi-maintainer org — a governance-maturation signal), and cargo-machete ([bnjbvr/cargo-machete](https://github.com/bnjbvr/cargo-machete), deliberately imprecise by design, accepting false positives such as [#78](https://github.com/bnjbvr/cargo-machete/issues/78) as a tradeoff for speed) round out the landscape. They stay in scope as context only — none is a v1 competitor, since v1 is TS/JS-only (CLAUDE.md).

## 4. Free/paid line

The dividing line is the credential boundary (ADR 0002), not an architecture line: free OSS is anything driven from the engineer's own environment with their own credentials; paid hosted is anything our cloud does on the engineer's behalf.

Free OSS is single-repo analysis, multi-repo analysis in a local environment (repos the user has checked out), local log-file analysis, and remote-source queries using the user's own credentials — e.g. CloudWatch via an AWS profile — across all evidence tiers, so long as they're locally driven. It never phones home and carries zero telemetry (CLAUDE.md non-negotiable, unchanged) — a trust feature, not a cost-saving measure, and part of what differentiates this product's trust stance from a tool willing to instrument production. The trust wording is now precise rather than architectural: the CLI makes network calls only to sources the user explicitly configures, with the user's credentials, and never to unused's servers.

Paid hosted is managed cloud connectors — the platform holds prod-log/telemetry/analytics access so engineers don't need to — plus a team dashboard, history and trends, a hosted badge, and scheduled analysis.

The rationale for drawing the line here rather than at architecture or evidence tier: the credential boundary is the only framing that doesn't charge for evidence the user's own environment can already produce for free — which is what an evidence-tier split did, and why it read as crippling (ADR 0002). The paid build itself is deferred, not built, but the contracts it needs — the claim schema, the plugin interface — are being designed now so paid can slot in later without a rewrite.

Consequence: the OSS surface grows — log parsers and remote-source drivers (files, AWS, OTel later) now live in the open core, alongside single-repo analysis — and the paid pitch sharpens to convenience, credential separation, and accumulated history, value a fork can't shortcut regardless of how much code it copies.

## 5. Business goals (indie/bootstrap)

The commercial target matches the founder's actual constraints, not a growth-stage plan: £10–30k MRR from hosted subscriptions, under £10k total spend in year one, 10–20 founder-hours per week (CLAUDE.md). Every downstream decision — architecture, scope, what gets built versus deferred — is optimised against that budget of time and money, not a hypothetical funded competitor's resources. It's also why the free/paid line in §4 sits where it does: the OSS tool carries the adoption load without needing paid infrastructure or support headcount to exist yet.

Until the hosted product exists, OSS adoption is the only available KPI, measured indirectly. `npx` runs can't be counted — a direct consequence of the zero-telemetry commitment in §4, an accepted tradeoff rather than an oversight: no adoption numbers beats compromising the trust stance that makes it worth adopting. The proxies are GitHub stars, shared deletion reports circulating organically, and README badges in the wild — weaker than a usage dashboard, but consistent with a bottom-up, no-telemetry product.

No funding is assumed, and no support or consulting treadmill is planned — both would consume the founder-hours budget this plan depends on, and neither fits 10–20 h/week solo.

## 6. Risks

**False positives destroy trust — the existential risk.** Not one risk among several; it's the risk the entire thesis in §1 responds to, and §3 shows what happens when it isn't managed: every incumbent tool, including the market leader, carries open, multi-year false-positive issues, each one paid for in user trust. If this product's FP rate isn't demonstrably better, there is no reason for anyone to switch. Mitigation: a golden-fixture corpus gating every merge (CLAUDE.md: "no exceptions"), graded confidence rather than binary verdicts, `why_alive` explanations so a wrong-looking claim can be checked rather than just distrusted, an explicit alive-when-uncertain policy, and hand-triaged smoke runs against real OSS repos each milestone — fixtures alone won't catch what messy real codebases surface.

**Incumbent bundling / fast follower.** Two ways to lose, both credible: Knip adds evidence grading and closes the gap from its overwhelming distribution (43M downloads/month), or Fallow — already shipping static+runtime fusion, already with an MCP server, a team, and momentum this product does not have — reaches the zero-integration runtime beachhead (§3) first. Of the two, Fallow is the sharper threat: it isn't hypothetical, it's shipping now, from a funded team, on essentially this document's own thesis. Mitigation is speed, not defensibility-by-design: tiers 2 and 4 (test-only liveness, access-log correlation) are both still unoccupied per the research, and the durable assets to build while that window is open are the correlation engine, the fixture corpus, and the trust brand — none copyable from a changelog.

**Single-founder bus factor.** The uncomfortable parallel: Knip itself runs on 83% single-maintainer commits (§3) and is still the category leader, so this isn't disqualifying in this niche — but it is real, and it's this product's own risk, not just a competitor's. Mitigation: an OSS core so the project can outlive the founder's attention even in the worst case, ruthless scope control, and a docs-first process built for resumability across short, interrupted sessions (CLAUDE.md's "resuming a session" discipline exists for this).

**TS ecosystem churn.** Bundlers, frameworks, and module-resolution modes keep changing, and §3 shows what that costs a static analyser that doesn't keep up — Knip's framework-magic and monorepo-resolution issue classes (Vue SFC, Nx+Next.js Pages Router, pnpm catalog) preview the same maintenance burden here. Mitigation: a plugin/preset interface plus per-framework fixtures, so a new framework quirk is an isolated addition, not a core rewrite.

**OSS free-riding / hosted clones.** Accepted as a cost of doing business, not defended against: anyone can fork the OSS core and offer a competing hosted product. The credential-boundary revision (ADR 0002) widens what a fork gets for free — local log parsers and remote-source drivers now sit in the open core alongside single-repo analysis — but the mitigation is unchanged: paid value is the connectors and the history they accumulate, and a clone starting from zero can't shortcut the time axis, only the code.

## Open questions

- Package name — decided at the Phase 1 gate: publishing as `@ninthwave-io/unused` (bin `unused`), matching the ninthwave-io GitHub org. npm org registration is a pending founder action; disputing the unscoped `unused` name is worth attempting in parallel.
- See docs/progress.md gate list for the remaining founder-gated items.
