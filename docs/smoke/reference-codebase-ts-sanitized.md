# Real-customer smoke assessment — private repo (sanitized)

Date: 2026-07-19. Analyzer: `unused` 0.1.0 (post-M9, v1 build complete).
Method per ADR 0009 / PRD §8, applied to the first real-customer repo
(private-beta candidate) rather than a pinned OSS smoke repo.

**Privacy note**: the analyzed repository is a private, real customer
codebase. Nothing identifying it — no paths, symbol names, package names,
or business-domain details — appears below. All findings are described
generically; every reproduction is a from-scratch minimal fixture using
placeholder names (`Widget`, `MyStack`, `pkg-a`/`pkg-b`), built fresh for
this write-up and containing no code or identifiers from the source repo.
The full identified triage exists only in a private scratch workspace and
was never committed anywhere in this repository.

## Repo shape (generic)

A real-world pnpm/Nx monorepo: 18 TS/JS workspace packages (one large
Vite + React SPA with Storybook and a Capacitor mobile wrapper, one
Node/Lambda service, one static marketing site, several shared libraries,
one AWS CDK infrastructure-as-code package, and several Cloudflare
Workers), ~2,479 TS/JS/TSX/JS(X)/MJS/CJS files, alongside a separate
non-umbrella backend service in another language entirely outside the
JS/TS surface (not analyzed by this tool; noted only for layout
completeness). Dependencies were installed (`pnpm install`, no build step)
to model a developer's real working checkout rather than a fresh CI
clone — a deliberate departure from the M3-M5 OSS-repo "clone before
install" methodology, chosen because this run is meant to represent what
a founder actually sees running the tool against their own live repo.

Zero-config workspace detection found all 18 packages correctly with no
config file. Run: exit 0, zero stderr, `schemaVersion: "1.1.0"`.

## Claim counts

| Kind | unused | test-only | total |
|---|---|---|---|
| export | 96 | 93 | 189 |
| file | 163 | 106 | 269 |
| dependency | 4 | 0 | 4 |
| test (zombie) | 0 | 15 | 15 |
| **total** | **263** | **214** | **477** |

Confidence: **0 high / 477 medium / 0 low.** `estDeletableLoc`: 50,170.
Zombie tests: 15 (`estCiSecondsPerRun: 75`, correctly labelled
`estimated: true`, never presented as a measurement).

## False positives found

**High-confidence claims on the real repo: 0** — but this run demonstrated,
more starkly than any prior smoke run, that "0 high" is a hazard-cap
artifact rather than a sign of correctness: every finding below reaches
**HIGH confidence in an isolated, from-scratch minimal repro**, and one of
them (below) explains *why* it never surfaces above medium on this
specific repo.

### FP class 1 (by far the largest, ~19% of all claims): a build-tool convention that auto-discovers files via a glob in its own config, with no static import anywhere

The repo's component-development tool (a widely-used UI component
workbench, config-driven, config lists a file-glob pattern for the files
it renders) auto-discovers its own preview/demo files via a glob in its
config file — those files are never statically imported by application
code, by design. `unused` has presets for two build tools already
(marker-dependency-activated) but none for this one, so every
auto-discovered file looks exactly like ordinary dead code: **89 of the
163 `file`/`unused` claims (55%) were files of this exact shape** — the
single largest false-positive class in the run, ~19% of every claim the
tool emitted.

**Minimal repro (reaches HIGH, no other hazards present):**
```
package.json:        { "name": "widget-lib", "main": "src/index.ts" }
.storybook/main.ts:  export default { stories: ['../src/**/*.stories.tsx'] };
src/Widget.tsx:       export function Widget() { return null; }
src/Widget.stories.tsx:
  import { Widget } from './Widget';
  export default { component: Widget };
  export const Default = {};
```
Result: `file  src/Widget.stories.tsx  ...  HIGH  0 inbound references...`
— a fully-confident "delete this" verdict on a legitimate story file. A
reference implementation of this exact tool's config format ships a
built-in plugin for it and correctly excludes every one of these 89 files;
`unused` currently has no equivalent.

**Fix shape**: a preset (same mechanism as existing presets) — on
marker-dependency activation, parse the tool's config file for its glob
list and seed every matched file as a production entrypoint.

### FP class 2: an infrastructure-as-code tool's non-`package.json` entrypoint convention

A popular cloud infrastructure-as-code framework declares its deployable
entrypoint via its own config file (a JSON file naming a script to run),
not via `package.json#main`/`#bin`. That entrypoint file imports and
instantiates several real infrastructure-definition classes — genuinely
live code. `unused` doesn't know this convention, so the entrypoint file
itself is claimed dead (0 inbound references — true from a pure
import-graph view, since nothing statically imports a CLI-invoked entry
script), which cascades: every infrastructure class it references falls to
`test-only`, and **every one of that workspace's infrastructure tests
becomes a false "zombie test"** claim (6 zombie-test claims, all one root
cause; 13 further file-level claims in the same package from the same
cascade — 19 wrong claims total from one gap).

**Minimal repro (reaches HIGH):**
```
cdk.json:            { "app": "npx tsx bin/app.ts" }
bin/app.ts:           import { MyStack } from '../lib/my-stack'; new MyStack();
lib/my-stack.ts:      export class MyStack { constructor() {} }
test/my-stack.test.ts: imports and constructs MyStack
```
Result (embedded as one member of a 2-workspace monorepo, alongside a
second, healthy workspace): `bin/app.ts` -> `file`/`unused`/**HIGH**;
`lib/my-stack.ts` -> `file`/`test-only`/**HIGH**; the test ->
zombie/**HIGH**. Notably, the *identical* shape as a **standalone**
single-package repo correctly triggers the tool's existing "no production
entrypoints detected, nothing analysed" safety refusal instead of guessing
— the safety net exists and works, but only fires when the *entire run*
has zero entrypoints, not per-workspace. In a healthy 18-workspace repo
where 17 other workspaces resolve fine, one workspace's undetected
entrypoint convention degrades silently into confident wrong claims
instead of an honest warning.

**Verified workaround**: an explicit `entry` config for the workspace's
entrypoint script fixes this completely today (confirmed empirically).

**Fix shape**: a preset for this framework (marker dependency on its core
library; parse its config file's entrypoint field). Separately worth
considering: run the "zero entrypoints detected" safety check per
workspace unit, not only once for the whole analysis.

### FP class 3 (minor): a hybrid-mobile framework's native-platform packages

Two dependencies were flagged `unused` that are a well-known convention of
a popular hybrid-mobile framework: "platform" packages that exist solely
so the framework's CLI can locate and copy native iOS/Android code during
a sync step — they are never imported in JS in any app using this
framework, by design (confirmed: genuinely zero references anywhere,
including the framework's own config file). This is the same *shape* of
gap as keep-alive rules the tool already implements for other conventions
(a type-declaration package paired with its runtime package, a CLI binary
package, a workspace-protocol sibling) — just missing this framework's
specific convention.

**Fix shape**: extend the dependency keep-alive rule set with a
marker-config-activated rule (presence of this framework's config file at
a workspace root) exempting its platform-tier packages from the "declared
but never imported" check.

### Architectural finding: a single dynamic reference anywhere in a multi-workspace repo caps confidence for the *entire* analysis, not just its own package

This is the finding that explains why none of the above reached high
confidence *on the real repo* despite each reaching HIGH in isolation.
Every one of the 477 claims cited the identical hazard justification,
traced to a single dynamic `require()` call (a fully computed, non-string
argument, no derivable static prefix) inside one file that isn't even
part of any of the 18 workspace packages — an incidental non-source file
included in the discovery walk. Removing that one file didn't restore any
high-confidence claims either: it just fell through to the *next* dynamic
`import()` found anywhere else in the tree (this time inside real,
legitimate build tooling in an unrelated workspace) and capped everything
again. On a repo of this size, at least one dynamic require/import
existing *somewhere* is close to a structural certainty — meaning **zero
high-confidence output is close to guaranteed on any real multi-workspace
monorepo**, independent of how clean the actual code is.

**Root cause** (confirmed by source read): the hazard class responsible is
documented as scoping to "the importer's whole package when there is no
static prefix," but the empty-prefix case was never actually implemented
as package-scoped — it resolves to an empty string, which matches (via
`path.startsWith("")`) every file in the single shared reference graph
that spans *all* workspaces in one analysis run, not just the offending
file's own package.

**Minimal repro (reaches HIGH before, drops to medium after, in a
2-workspace monorepo with zero relationship between the packages):**
```
packages/pkg-a/src/index.ts:
  export function loadPlugin(moduleName: string) { return require(moduleName); }
packages/pkg-b/src/internal.ts:
  export function deadExport() { return 42; }   // zero references anywhere, unrelated package
```
Before `pkg-a` contains the dynamic `require`: `deadExport` (in the
completely unrelated `pkg-b`) claims `export`/`unused`/**HIGH**, no cap.
After adding the one dynamic `require(moduleName)` call to `pkg-a`:
`deadExport` drops to **medium**, citing `pkg-a`'s hazard by file path,
despite `pkg-b` having no dependency on `pkg-a` at all. (Confirmed the
shape matters: a template literal with a derivable static prefix, e.g.
`` require(`./plugins/${name}`) ``, does *not* leak this way — only a
fully opaque argument does, which is exactly the shape found in the real
repo.)

**Fix shape**: the empty-prefix fallback should resolve to the hazard
site's containing workspace-unit root (a boundary the analyzer already
computes elsewhere for other purposes), not to the whole shared,
multi-workspace graph.

### Scope gap noted, not a bug

A handful of test files (3, all in one workspace) exercise a build
pipeline's *output artifacts* (checking that expected files exist on disk
after a build) rather than importing any source file — invisible to any
source-level static analyzer, `unused` or the differential baseline alike,
by construction. Same treatment as a prior milestone's documented
"dynamic subprocess compile" scope gap: a hazard-registry entry candidate,
not a defect.

## Test-only / zombie claim triage

All 15 zombie-test claims were individually triaged (exhaustive, this
milestone's newer surface): 6 true positives (confirmed zero production
usage), 6 confirmed false positives (all one root cause — FP class 2
above), 3 honest scope gap (build-output tests, above).

Of the 199 export/file `test-only` claims, a full automated cross-check
(import-specifier and JSX-usage search against the whole repo, excluding
tests/comments) covered 100% of the population; ~30 items plus 3
representative flagged clusters were deep-traced individually. Result:
zero additional confirmed false positives beyond the FP class 2 cluster
already counted. The dominant noise source in the automated pass was
re-export barrels whose re-exported binding is legitimately never
consumed further (correctly hedged, matching prior milestones'
"public-API-shaped" class) plus generic-identifier-name collisions
unrelated to the actual claim.

## Medium-confidence sample (34 items, exceeds the ADR 0009 ≥30 default)

15 export + 15 file claims (stratified: half surfaced by the automated
cross-check, half not) plus all 4 dependency claims. 15/15 export samples
confirmed true positive — the dominant pattern was components that export
both a named binding (always what's actually imported, 7 confirmed
instances) and an unused default-export binding (correctly flagged unused
on the default only). File samples were dominated by genuinely-dead barrel
`index.ts` files, confirmed via directory-path import search that nothing
ever imports through the barrel path, only through direct file imports.

## Differential vs knip@6.27.0

Zero-config knip run at the same root: 223 issue-file records (files 62,
exports 243, types 388, duplicates 14, dependencies 3, devDependencies 12,
binaries 9). Timing ~2.99s wall (cached) vs `unused`'s ~4.1-4.4s (~1.4x —
same order of magnitude as the existing ≤1.23x-at-400-files checkpoint,
no red flag at this larger, 2,479-file/18-workspace scale).

**Direction A — knip flags a file, `unused` emits no claim at all (19
files, all triaged):** every single one turned out to be substantive
agreement, not disagreement — `unused why <file>` confirmed a verdict of
`unused` for each, just without a standalone claim because the tool
deliberately collapses transitively-subsumed dead files under their
nearest already-claimed dead ancestor (to avoid claim-count explosion on
large dead subtrees) rather than enumerating every file individually the
way knip does. `estDeletableLoc` still counts the subsumed files' size.
Two further files were simply out of `unused`'s v1 scope entirely (CSS),
and six were JS files belonging to a different tool's runtime outside the
package-manager-resolved surface altogether (a load-testing script
directory with no `package.json` anywhere in its tree) — not a
disagreement, a scope difference.

**Direction B — `unused` flags `file`/`unused`, knip does not (120 files,
triaged):** 89/120 (74%) are FP class 1 above (the auto-discovered
component-preview files) — knip ships a built-in plugin for that exact
convention and correctly excludes all 89; this is knip being right and
`unused` being wrong, the cleanest and highest-volume disagreement found.
Remainder: a handful of static assets loaded by URL at runtime rather than
imported (both tools are reference-graph-blind to this in principle; knip
appears to special-case at least one common instance of it) and more
genuinely-dead barrel files (§ above).

## Timing and file count

2,479 files, 18 workspaces, one cold-ish run (pnpm/node already warm):
`run.durationMs` 4,235ms internal; external wall clock 4.1-4.4s across two
clean repeat runs (`time`, user+sys ~4.6-5.1s at ~120% CPU). knip@6.27.0
on the same root: ~2.99s wall (cached `pnpm dlx`). Ratio ~1.37-1.46x knip
at this scale.

## Summary

Zero-config detection (workspace discovery, entrypoint resolution for 17
of 18 packages) worked correctly out of the box on a real, large,
messy, multi-workspace production monorepo neither `unused` nor its
fixture corpus had ever seen before. The two concrete, fixable preset/
convention gaps found (FP classes 1 and 2) account for 89 + 19 = 108 of
this run's 477 claims (23%) and both independently reach full HIGH
confidence in isolation — meaning they are real trust risks the moment
the architectural hazard-cap-scoping gap (which is masking them to medium
on this specific repo, and is itself the highest-priority fix) is
addressed. All three should land together: fixing the hazard-cap scope
bug without first adding the Storybook and CDK presets would make this
exact repo's experience *worse* on the next run, not better.
