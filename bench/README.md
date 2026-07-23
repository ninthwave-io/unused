# bench — timed cold runs

Founder directive (`CLAUDE.md`, "How we work"): benchmark performance from
the first analyzer milestone, timed cold runs on pinned targets, results
committed to the repo, Knip on the same target as the reference point. This
directory is that harness (task T2.6, `docs/phasing.md` M2).

`bench/` is a **standalone package, deliberately outside the pnpm
workspace** (`../pnpm-workspace.yaml` only globs `packages/*`). That keeps
the pinned reference tool's dependency tree — and its own lockfile — fully
isolated from `unused`'s own dependency graph. It has its own
`package.json`, `package-lock.json` (npm, not pnpm) and `node_modules`.

## Run it

```sh
cd bench
npm install        # first time only, or after bumping the pinned knip version
cd ..
node bench/bench.mjs                                    # JSON to stdout
node bench/bench.mjs --out docs/bench/$(date +%F)-fixtures.json
node bench/bench.mjs --runs 5 --out /tmp/results.json    # override run count
```

One command reproduces the whole run: `node bench/bench.mjs [--out <path>]`.
No other setup beyond `npm install` in `bench/` (a one-time step, same as
any pinned dev dependency).

### Generated scaling corpus

The independently generated TypeScript scaling corpus exercises several
workspaces, 32 exports per ordinary module, import fan-out, tests, literal and
computed dynamic imports, config roots, and a fixed dead-code fraction. It does
not contain or derive from any consuming repository. Generated projects default
to the operating-system temporary directory and are not committed.

```sh
pnpm build
node bench/generate-scaling-fixtures.mjs --out /tmp/unused-scaling-fixtures --variants
node packages/unused/dist/cli/index.js --performance --json \
  --cwd /tmp/unused-scaling-fixtures/files-2000 > /tmp/unused.json
```

`--variants` adds three orchestration shapes for every requested size: a root
TypeScript workspace plus a neutral Rust boundary, the same TypeScript project
nested beside Rust, and a many-boundary TypeScript layout (5, 10, 20, then 32
independent boundaries). Fixture roots are asserted unique. Root/nested retain
the direct TypeScript workload exactly. Many-boundary retains its own stable
test/config/hazard topology and is valid only for identical before/after
comparison; its symbols, edges, and claims are deliberately reported rather
than treated as cross-topology equivalents. Together these variants expose
work accidentally multiplied by languages, nesting, or boundary count.

To exercise ignored-tree scaling without changing the tracked source count,
add `--ignored-json 5000`. This creates a neutral generated-cache tree covered
by the fixture's `.gitignore`; it regression-tests that config extraction reuses
the bounded discovery inventory instead of traversing ignored artifacts.

On macOS, prefix the analyzer command with `/usr/bin/time -lp` for wall/CPU/RSS
evidence. Add `--cpu-prof --enable-source-maps` to Node for a CPU profile. The
`--performance` stream is newline-delimited JSON on stderr; canonical JSON
stdout remains diagnostic-free. Each phase event includes current RSS, heap
used/total, external and array-buffer bytes, and the current process's RSS
high-water mark. `/usr/bin/time -lp` remains authoritative for external peak RSS
and physical-footprint evidence, including platform accounting differences.

## What it measures

For every target in `bench/targets.json` (currently: each
`fixtures/ts/<case>` mini-repo) and every tool:

- **1 untimed warm-up run**, then **3 timed runs**, each a **fresh child
  process** — "cold" means a new OS process per invocation, not a cleared
  disk/page cache. A warm OS file cache across runs is expected and is not
  something this harness tries to defeat; see the `caveat` field in the
  output.
- Wall-clock time via `performance.now()` around the `spawnSync` call.
- **min** and **median** of the 3 timed runs, per target, per tool.
- Exit code (for every run) and a truncated stderr snippet, captured
  **regardless of outcome** — a tool that exits non-zero (Knip does this
  whenever it finds issues — that's not a crash) or fails to spawn is still
  fully timed and fully reported, never dropped from the results.

### Tools

- **knip** — pinned exactly at `knip@6.27.0` (no `^`/`~` range) as a
  `bench/` devDependency, invoked via its own bin
  (`bench/node_modules/.bin/knip --no-config-hints`). `--no-config-hints`
  is used because these fixture mini-repos intentionally ship no
  `knip.json` — that's expected, not a bug in the target, and hint noise
  isn't something we want in a timing artifact. Observed on the current
  fixture corpus: knip runs cleanly on every target (exit 0 when a fixture
  is genuinely clean, exit 1 whenever it reports unused exports/files —
  the expected "found issues" exit code, not a failure to run).
- **unused** — reads the command spec from `bench/targets.json#tools.unused`
  (`packages/unused/dist/cli/index.js --json`, resolved repo-relative) and
  checks whether that build output exists yet, timing it the same way as
  knip when it does. If `dist/` hasn't been built (`pnpm run build` from the
  repo root), every result for this tool is reported as `status: "pending"`
  with a `note` explaining why — never an error, never a silently-skipped
  row — rather than the harness failing outright.

## The startup-dominated caveat

At today's fixture scale (a handful of files per mini-repo), timings are
dominated by Node process startup and module load, not by analysis work —
knip's own runs land around 150–300ms per invocation on typical hardware,
almost all of it startup. **These numbers are not a proxy for real-repo
performance** and shouldn't be read against the PRD §8 budget (a
~5,000-module repo in under 60s cold / 10s warm). Every results file
carries this as a `caveat` string in its metadata so it travels with the
data, not just this README.

Real numbers arrive with the M3 smoke repos (`docs/phasing.md` M3, T3.5) —
pinned, larger, real-world targets where process-startup noise stops
dominating the signal.

## Adding targets

Edit `bench/targets.json`:

- `targets`: array of directory names under `fixturesRoot`
  (`fixtures/ts/<name>`, one mini-repo per entry).
- `tools.<name>`: `bin` (path), `binRoot` (`"bench"` — resolved against
  this directory, e.g. the pinned knip bin — or `"repo"` — resolved
  against the repo root, e.g. the `unused` CLI build), and `args`.

M3 adds pinned smoke repos as new targets (larger, real-world code, not
mini fixtures) — likely as a second `fixturesRoot`-style entry or a
`targets[].path` override once that shape is needed; this file intentionally
stays simple until that's a real requirement rather than a guess.

## Output shape

`bench.mjs` writes one JSON object: run metadata (`generatedAt`, `harness`
run-count/warm-up config, `machine` — OS/CPU/Node, no usernames or
absolute paths), the `caveat` string above, a `tools` block identifying
what ran (knip's pinned vs. installed version; `unused`'s
available/pending status), and a `results` array — one entry per
target × tool, each with `status` (`"ok"` / `"pending"` / `"error"`),
`exitCodes`, `minMs`, `medianMs`, `warmupMs`, and `stderrSnippet`.

Key order is deterministic (fixed construction order in `bench.mjs`), so
diffs between two results files are timing-only noise, not structural
churn — expected to vary run to run; a results file is a point-in-time
record, not a value CI diffs against.

First results: `docs/bench/2026-07-18-fixtures.json`.
