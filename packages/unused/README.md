<p align="center"><strong>unused</strong> — a liveness oracle for software</p>

```
npx @ninthwave-io/unused
```

No install, no config, no account. Point it at a TS/JS repo and it tells you what's truly dead — with a confidence grade and a one-line "why" for every claim, so you (or your coding agent) can trust the answer enough to delete.

Analysis is read-only by default, and `unused` never opens a PR or commits for you. An explicit, conservative `--fix` can apply reviewable working-tree edits — and the tool never phones home: **zero telemetry, always.**

## The evidence ladder

Every claim `unused` makes sits on a graded ladder, from proven to probable:

1. **Static reachability** — unused exports, files, and dependencies, from reference-graph analysis. Deterministic, local, fast.
2. **Test-only liveness** — code kept alive only by a test, plus the zombie tests and CI seconds wasted keeping it that way.
3. **Cross-boundary static** — API routes, tRPC procedures, and GraphQL fields with no consumer anywhere in the repo (schema ships in v1; extraction lands post-v1).
4. **Runtime evidence** *(schema reserved, not yet implemented)* — reachable, but zero production traffic over a window.
5. **Human-usage evidence** *(schema reserved, not yet implemented)* — served, but untouched by users.

Every claim is a **subject + verdict + confidence + evidence + provenance** — never a bare "unused" with no way to check the tool's work.

## What a run looks like

```
unused v0.1.0 — acme-web (1,284 files, 3 workspaces) — 4.2s

  12 unused exports · 3 unused files · 2 unused dependencies
  ~1,840 deletable LOC · 7 test-only symbols · 2 suppressed

UNUSED EXPORTS                                        confidence
  ● formatCurrency   src/utils/currency.ts:12   no refs from any entrypoint
  ● parseLegacyId    src/utils/ids.ts:44        no refs from any entrypoint
  ◐ getFlags         src/flags.ts:9             unused, but dynamic import nearby

TEST-ONLY (production-dead, kept alive by tests)
  ● OrderMapper      src/orders/mapper.ts:30    only ref: orders.spec.ts — ~14 CI s/run

  ○ 3 low-confidence candidates hidden — `unused --min-confidence low` to show
  2 suppressed — `unused --show-suppressed`

next: `unused why formatCurrency` · `unused --json` · docs: unused.dev
```

`●` high confidence, `◐` medium, `○` low — shape and color both, never color alone. High confidence first, ranked by deletable LOC: the first screen is always the best deletions in the repo, not a wall of maybes.

## Why trust the "high" claims

**False positives are the metric that matters most here** — above recall, above speed, above feature breadth. A tool that under-reports dead code is annoying; a tool that confidently tells you to delete something live is dangerous, and that's the trust the whole product depends on.

`high` confidence means "safe to act without re-deriving the reference graph yourself" — under a **published, enumerated assumption set**: module resolution follows tsconfig/package.json exactly, declared entrypoints are treated as the complete public API, and every dynamic-reference hazard the analyzer knows how to detect (string/computed imports, `require(expr)`, config-referenced files, framework conventions) forces a downgrade to `medium` rather than a confident wrong answer. Anything the analyzer can't see stays your call.

The full list is generated from the analyzer's own code, so it can't drift from what the tool actually does: **[docs/generated/assumption-set.md](https://github.com/ninthwave-io/unused/blob/main/docs/generated/assumption-set.md)**.

## Quickstart

**1. See what's dead**

```
npx @ninthwave-io/unused
```

Zero-config: it auto-detects entrypoints, workspaces, tsconfig, and test files. First run, no setup.

**2. Ask why, before you delete anything**

```
npx @ninthwave-io/unused why formatCurrency
npx @ninthwave-io/unused why --delete formatCurrency
```

Prints the shortest reference path if it's alive (entrypoint kind labelled — production, test, or config), or the verdict, confidence, and evidence if it's dead. `--delete` adds required re-export edits and staged “this becomes newly dead” consequences without changing files. It also works for dependency claims.

**3. Apply conservative fixes, then review the diff**

```
npx @ninthwave-io/unused --fix
npx @ninthwave-io/unused --fix --fix-type files --allow-remove-files
```

The default fixes only unsuppressed, high-confidence unused exports and dependencies. File removal has two explicit opt-ins. A run freezes its initial claim set, edits only safely matched shapes, re-analyses, and reports newly exposed work; it never stages or commits.

**4. Gate CI on new dead weight, not the backlog**

```
npx @ninthwave-io/unused baseline   # once, on main: bless the current state
npx @ninthwave-io/unused check      # every PR: fail only on claims new since baseline
```

A hard "fail everything" gate on a codebase with years of history gets ignored within a week. `check` compares against a committed baseline and fails only on what a PR *adds*.

**5. Give it to your coding agent**

```
npx @ninthwave-io/unused mcp
```

Starts a read-only, stdio MCP server over the same engine: `find_unused` (thresholdable bulk query), `why_alive` (the reference-path check above), `usage_evidence` (runtime/human-usage evidence slots, explicit "not configured" where no source is wired up). Point any MCP-capable client at it, e.g.:

```json
{
  "mcpServers": {
    "unused": { "command": "npx", "args": ["@ninthwave-io/unused", "mcp"] }
  }
}
```

**Bonus: a shareable report and a README badge**

```
npx @ninthwave-io/unused report --md     # writes .unused/report.md — headline totals, top deletions, one screen
npx @ninthwave-io/unused badge           # writes .unused/badge.json — a shields.io endpoint badge
```

```md
[![unused](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/<you>/<repo>/main/.unused/badge.json)](https://unused.dev)
```

The report is generated locally and reveals file paths and symbol names from your repo — it says so on the page itself. Review before pasting it into a public PR or Slack channel.

## Configuration (optional)

Zero-config is the default path — most first runs happen before anyone's decided the tool is worth configuring, so the false-positive bar holds without a config file. Where auto-detection needs a nudge:

```jsonc
// unused.config.jsonc
{
  // Next.js preset seeds file-based route entrypoints; these add to it.
  "entry": ["src/index.ts", "src/pages/**/*.tsx"],
  // Ordered claimability patterns; files remain visible to the graph.
  "project": ["src/**/*.{ts,tsx}", "!src/generated/**"],
  "suppressions": [
    {
      "files": ["src/legacy/**", "**/*.generated.ts"],
      "kinds": ["export", "file"],
      "reason": "generated or retained during the legacy migration"
    }
  ],
  "ignoreDependencies": ["@types/node"],
  "workspaces": {
    "packages/api": { "entry": ["src/server.ts"] }
  },
  "gate": { "threshold": "medium" }
}
```

Suppress a single false positive inline, with a mandatory reason so it's still legible six months later:

```ts
/* unused:ignore migration to v2 API pending, keep until Q3 */
export function legacyHandler() { /* ... */ }
```

Suppressed claims remain in JSON and SARIF with their reason and policy provenance. Human output hides them from the actionable list and reports a separate suppressed count; use `--show-suppressed` to inspect them. Discovery respects applicable nested `.gitignore` rules by default; `--no-gitignore` provides an explicit audit view.

## Zero telemetry, always

The OSS CLI makes network calls **only to sources you explicitly configure, with your own credentials — never to us.** No usage tracking, no crash reporting, no "anonymous" analytics, no phone-home, ever, under any circumstance. That's not a privacy nicety bolted on afterward; it's a trust feature the whole tool leans on, and it's checked into the free tier permanently, not a limited trial of something that later starts calling home.

## Roadmap

`unused` ships TS/JS-only in v1 — that's where the false-positive pain lives today, and precision-critical scope shouldn't dilute across ecosystems before one is proven trustworthy. The core (reference graph, claim engine, reporters) is language-agnostic by design, so each language lands as a frontend, not a rewrite. **Python next, then Elixir.**

## License

MIT — see [LICENSE](LICENSE). `unused` is free, permanently, for anything driven from your own environment with your own credentials. The hosted platform (managed connectors, team dashboard, history) is a separate paid product, built later, on top of the same open core — never a crippled trial of this one.

---

Docs: [unused.dev](https://unused.dev) · Issues: [github.com/ninthwave-io/unused](https://github.com/ninthwave-io/unused)
