# Polyglot fragment memory correction — 2026-07-23

All fixtures and measurements in this note use independently generated neutral
code. No consuming-project identifiers, paths, source, symbols, configuration,
artifacts, prose, or raw output are present.

## Scope and method

- Base: `66495b347ff7684957d0fa45b648ca23c101201c`
- Machine: Apple M4 Pro, arm64, macOS 26.3.1
- Runtime: Node 22.16.0, pnpm 10.30.3
- Command: a fresh process running `unused --performance --json --cwd DIR`,
  wrapped by `/usr/bin/time -lp`
- Statistic: median of three fresh-process runs; CPU is user + system time and
  RSS is `/usr/bin/time` maximum resident set size
- Sizes: exactly 250, 500, 1,000, 2,000, and 3,000 tracked source files

`bench/generate-scaling-fixtures.mjs --variants` creates four topologies:

1. `direct`: the existing four-workspace TypeScript fixture;
2. `root-mixed`: the same TypeScript density plus one neutral Rust source;
3. `nested-mixed`: the TypeScript project nested beside the Rust boundary;
4. `many-boundary`: 5, 10, 20, 32, and 32 independent TypeScript boundaries.

The many-boundary topology keeps its own density stable rather than serving as
a substitute for the direct topology. At 250 files it has 20 test roots, five
config roots, five reachable computed-import hazards, five literal dynamic
imports, 7,275 symbols, 19,840 edges, and 590 claims. At 3,000 files it has 224
test roots, 32 config roots, 32 reachable computed hazards, 64 literal dynamic
imports, 89,592 symbols, 244,336 edges, and 5,176 claims. Before/after compares
the identical generated artifact; no counter is reduced to obtain the result.

## Cause and correction

Repository orchestration called each language frontend's complete analyzer.
Every frontend therefore allocated local reachability partitions, predecessor
maps, hazard closure, claims, and summary before dispatch discarded those
objects and repeated the work globally. Dispatch then evaluated hazards and
emitted claims once per fragment, but both APIs still cloned or scanned the
whole merged graph. With `B` boundaries this left Θ(`B × (V + E)`) work and
transient allocation even after local analysis was removed.

Language plugins now return a graph-complete fragment before local reachability
or claims. Boundary-local suppression and compiler evidence are retained as
bounded subject annotations. Dispatch builds graph-wide immutable hazard and
claim indexes once; each fragment then visits only its owned files, symbols,
hazards, dependencies, and test roots. Global reachability remains one pass.
The sum across disjoint fragments is Θ(`V + E`) plus real hazard propagation
and bounded zombie-test walks.

Nested rebasing now shares one path/site canonicalization context across graph,
claim inputs, deferred contributions, and diagnostics. POSIX dot segments are
normalized; absolute and escaping paths are rejected. This reduces duplicate
path/site allocation and prevents alias graph identities, but it does not yet
remove the temporary old-graph/new-graph overlap during nested rebasing.

## Scaling results

Wall time, peak RSS, and graph walks:

| Topology | Files | Before wall s | After wall s | Before RSS MiB | After RSS MiB | Before walks | After walks |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| direct | 250 | 0.30 | 0.29 | 147.0 | 147.4 | 23 | 23 |
| direct | 500 | 0.44 | 0.43 | 167.8 | 165.7 | 43 | 43 |
| direct | 1,000 | 0.76 | 0.72 | 236.8 | 238.8 | 87 | 87 |
| direct | 2,000 | 1.33 | 1.29 | 311.6 | 314.0 | 175 | 175 |
| direct | 3,000 | 1.99 | 1.97 | 404.3 | 399.6 | 263 | 263 |
| root-mixed | 250 | 0.47 | 0.42 | 155.9 | 150.7 | 49 | 23 |
| root-mixed | 500 | 0.63 | 0.56 | 177.4 | 168.2 | 89 | 43 |
| root-mixed | 1,000 | 1.01 | 0.86 | 258.8 | 247.1 | 177 | 87 |
| root-mixed | 2,000 | 1.84 | 1.48 | 326.3 | 322.8 | 353 | 175 |
| root-mixed | 3,000 | 2.78 | 2.23 | 459.3 | 419.9 | 529 | 263 |
| nested-mixed | 250 | 0.46 | 0.44 | 154.5 | 150.4 | 49 | 23 |
| nested-mixed | 500 | 0.67 | 0.60 | 190.7 | 177.6 | 89 | 43 |
| nested-mixed | 1,000 | 1.09 | 0.93 | 271.1 | 256.1 | 177 | 87 |
| nested-mixed | 2,000 | 1.93 | 1.59 | 377.0 | 332.8 | 353 | 175 |
| nested-mixed | 3,000 | 2.80 | 2.31 | 572.5 | 496.8 | 529 | 263 |
| many-boundary | 250 | 0.31 | 0.31 | 142.4 | 140.2 | 58 | 23 |
| many-boundary | 500 | 0.50 | 0.45 | 190.0 | 178.3 | 113 | 43 |
| many-boundary | 1,000 | 0.92 | 0.75 | 246.3 | 220.8 | 223 | 83 |
| many-boundary | 2,000 | 1.78 | 1.32 | 381.0 | 307.7 | 419 | 163 |
| many-boundary | 3,000 | 2.63 | 1.87 | 535.4 | 367.4 | 547 | 227 |

At 3,000 files, corrected wall time is 20% lower for root-mixed, 18% lower
for nested-mixed, and 29% lower for the identical many-boundary artifact. Peak
RSS is 8.6%, 13.2%, and 31.4% lower respectively. Files, symbols, edges, claims,
workspaces, resolution attempts, and deletion simulations are invariant within
each before/after row. Many-boundary fixed-point iterations fall from 10 to 5
at 250 files and from 64 to 32 at 3,000 because the duplicate local/global
hazard pass is gone, not because hazards were removed.

CPU medians at 3,000 files:

| Topology | Before CPU s | After CPU s |
| :--- | ---: | ---: |
| direct | 2.91 | 2.84 |
| root-mixed | 3.86 | 3.17 |
| nested-mixed | 4.01 | 3.34 |
| many-boundary | 3.98 | 2.92 |

Every 2,000–3,000-file topology is comfortably inside the provisional
two-minute interactive budget, and the corrected curves are near-linear. The
many-boundary result must only be compared to its own before state because its
test/config/hazard/claim topology intentionally differs from `direct`.

### 3,000-file phase medians (milliseconds)

| State/topology | Discover | Workspace | Parse | Resolve | Conventions | Graph | Reachability | Hazards | Claims | Evidence | Delete | JSON |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| before direct | 20.1 | 4.1 | 1,059.2 | 24.2 | 102.4 | 203.9 | 184.9 | 30.8 | 150.9 | 0 | 0 | 24.7 |
| after direct | 20.0 | 4.1 | 1,057.7 | 23.2 | 100.0 | 188.7 | 167.4 | 29.4 | 146.0 | 0 | 0 | 24.7 |
| before root-mixed | 23.3 | 24.5 | 1,160.7 | 24.1 | 107.9 | 232.8 | 369.0 | 81.0 | 442.7 | 0 | 0 | 24.6 |
| after root-mixed | 20.2 | 23.4 | 1,156.5 | 23.6 | 108.0 | 229.7 | 191.1 | 30.4 | 189.4 | 0 | 0 | 22.5 |
| before nested-mixed | 21.9 | 22.4 | 1,137.5 | 23.5 | 103.2 | 215.8 | 290.5 | 76.1 | 366.6 | 0 | 0 | 24.0 |
| after nested-mixed | 21.5 | 22.7 | 1,137.4 | 24.5 | 106.4 | 210.7 | 129.7 | 25.5 | 144.6 | 0 | 0 | 23.6 |
| before many-boundary | 29.8 | 35.3 | 1,039.5 | 18.4 | 137.2 | 138.7 | 65.2 | 277.3 | 548.2 | 2.2 | 0 | 7.3 |
| after many-boundary | 29.5 | 29.6 | 1,004.9 | 18.7 | 134.6 | 136.8 | 47.9 | 20.8 | 107.0 | 1.5 | 0 | 7.1 |

Phase NDJSON now also records RSS, heap used/total, external bytes,
array-buffer bytes, and current-process maximum RSS. Fragment counters are
cumulative and monotonic at the phase where each fact becomes known; ordinary
JSON deletion simulations remain zero.

## Mode-specific cost

Corrected nested-mixed 2,000-file medians:

| Mode | Wall s | CPU s | Peak RSS MiB | Graph walks | Delete simulations |
| :--- | ---: | ---: | ---: | ---: | ---: |
| terminal | 1.58 | 2.40 | 312.1 | 175 | 0 |
| `--json` | 1.59 | 2.40 | 330.5 | 175 | 0 |
| filtered dependency JSON | 1.57 | 2.37 | 311.9 | 175 | 0 |
| `why --delete --json` | 1.72 | 2.59 | 334.2 | 178 | 1 |

Ordinary, canonical JSON, and filtered JSON perform no deletion consequence
simulation. Only the explicitly selected `why --delete` subject performs one.

## CPU profile evidence

Node CPU profiles with source maps were captured on the identical 3,000-file,
32-boundary artifact. Before correction, 2,391 samples included
`evaluateHazards` (278), `emitClaims` (219), zombie-test emission (96), and GC
(206) among the leading frames. After correction, 1,548 samples were dominated
by native Oxc parsing/module loading; neither `evaluateHazards` nor `emitClaims`
appeared in the top fifteen, and GC fell to 123 samples. Profiles remain local;
only these de-identified aggregates are committed.

## Acceptance and remaining work

This slice corrects duplicate local/global analysis and the boundary multiplier,
preserves claim IDs/verdicts/counts, keeps JSON stdout schema-valid, and adds
workspace package attribution to nested file/test claims where the former
adapter omitted it. That package field is an intentional additive correctness
fix; direct and nested workspace analysis now agree.

It is not the final memory acceptance. At 3,000 files, nested-mixed peak RSS is
496.8 MiB versus 399.6 MiB direct (24.3% overhead), above the provisional 15%
target. The remaining P1 is ownership-transfer/in-place repository rebasing so
the boundary-local graph and repository-relative clone do not coexist at peak.
Private consuming-project reruns remain blocked until that slice is measured.

A separate pre-existing modular-config NO-GO also remains intentionally outside
this atomic performance correction: nested local `entrySymbols`, repository
workspace preset projection, and deterministic root + boundary config-hash
aggregation. Its acceptance must cover TS, Elixir, and Rust local symbol roots,
`why`/`why --delete`, no cross-boundary over-rooting, forced presets, and the
policy that repository/root config owns the final gate threshold and summary
economics while boundary-local config owns discovery, claimability,
suppression, and local roots.

## Rust decision

No Rust rewrite is justified. The measured hot path was repeated JavaScript
graph work with Θ(`B × (V + E)`) architecture, corrected to shared indexing and
owned linear scans. After correction the profile is led by the native
Rust-backed Oxc parser. Moving bounded claim/hazard selection across an FFI
boundary would add graph serialization, duplicate contracts, and maintenance
cost while targeting a small residual. The next performance work is eliminating
the graph clone/ownership overlap, not translating the same algorithm to Rust.
