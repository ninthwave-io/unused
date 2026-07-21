# TypeScript scaling investigation — 2026-07-21

Every fixture and committed measurement in this investigation uses only
independently generated neutral TypeScript code. No consuming-project
identifiers, paths, source, symbols, configuration, artifacts, prose, or raw
output are present in this repository.

## Environment and method

- Base commit: `5abd6ada8b7959beb6d21d4b577f97a1a6258cf3`
- Machine: Apple M4 Pro, arm64, macOS/Darwin 25.3.0
- Runtime: Node 22.16.0, pnpm 10.30.3
- Command: fresh Node process running `unused --performance --json --cwd DIR`
- External measurement: `/usr/bin/time -lp`; peak RSS is maximum resident set
  size. Internal CPU is `process.resourceUsage()`.
- Corpus: `bench/generate-scaling-fixtures.mjs`, at exactly 250, 500, 1,000,
  2,000, and 3,000 tracked TS source files. Each size has four package
  workspaces plus the root unit, 32 exports per ordinary module, three-way
  import fan-out, test roots, dynamic imports, config roots, and 12% dead
  modules. No size reduces symbol, edge, hazard, or claim density.
- “Before” was measured by temporarily restoring the two legacy algorithms in
  the same instrumented checkout, running fresh processes, then restoring the
  corrected implementation. Those temporary reversions and generated projects
  were not committed.

`--performance` emits a deterministic NDJSON phase stream and final summary to
stderr. It records discovery/ignore evaluation, workspace/config detection,
parsing, resolution, convention/config roots, graph construction, partitioned
reachability, hazard fixed-point activation, claim generation, shortest-path
evidence, deletion planning, and report/JSON assembly. Counters cover files,
symbols, edges, claims, workspaces, resolution attempts, graph walks,
fixed-point iterations, and deletion simulations. Unused phases are reported as
zero rather than omitted.

## Root cause

Three independent scaling defects composed:

1. Intra-file emission performed a DFS from every exported symbol and
   materialized edges to every exported descendant. A chain of `E` exported
   declarations therefore created Θ(E²) edges even though reachability only
   needs the first exported boundary: that boundary's own outgoing edge carries
   the rest of the path.
2. Zombie-test classification completed a fresh whole-graph reachability walk
   for every test root. This was Θ(T × (V + E)). Most ordinary tests prove they
   are not zombies after reaching the first production/config-live node, but the
   legacy implementation continued to exhaustion.
3. Convention/config extraction discarded the bounded discovery result and
   recursively walked the project filesystem again. That second walker honored
   neither `.gitignore` nor the complete build-output exclusions, so ignored
   dependency and generated trees could dominate runtime even when none of
   their files belonged to the analysis. Config JSON and package roots now come
   from the same single gitignore-aware inventory as source discovery.

The reachability queue also used `Array.shift()`, adding avoidable compaction
cost. It was not the primary profiler frame but amplified large walks.

The config-string locator also rescanned every file prefix to calculate each
literal's line number, giving a file with many strings quadratic offset work.
It now advances one newline cursor across the source, preserving identical
spans in linear time.

The correction emits only export-to-first-export edges while preserving the
same transitive reachability, uses an indexed queue, and terminates a per-test
walk as soon as a production/config-live or uncertain node is encountered. A
full isolated walk still occurs for a genuine zombie candidate. Claim counts
are identical before and after at every size.

An additional architectural audit found that ordinary terminal and `--json`
modes already performed zero deletion simulations. The shareable `report`
command, however, eagerly simulated every eligible claim even though it renders
only ten. It now plans exactly the bounded top ten. `why --delete` continues to
plan exactly one selected subject.

### Ignored-tree stress regression

The generator's optional `--ignored-json` mode independently constructs an
ignored neutral cache without changing the requested tracked source count. A
250-source fixture with 5,000 small JSON artifacts under 5,101 ignored
directories produced this cold comparison:

| State | Wall s | CPU user+sys s | Peak RSS MB | Convention/config ms | Files | Symbols | Edges | Claims |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| legacy raw config walk | 1.31 | 1.62 | 160 | 823.412 | 250 | 7,348 | 20,382 | 1,674 |
| shared bounded inventory | 0.49 | 0.71 | 153 | 16.080 | 250 | 7,348 | 20,382 | 1,674 |

The corrected phase is 51× faster in this stress case while every analyzed
file, symbol, edge, and claim counter is unchanged. Generated ignored artifacts
are excluded because they are outside the analysis boundary, not because the
benchmark reduced its tracked workload.

## Scaling curve

### End-to-end and invariant counters

| Files | Before wall s | After wall s | Before CPU user+sys s | After CPU user+sys s | Before peak RSS MB | After peak RSS MB | Claims (both) | Edges before | Edges after |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 250 | 0.33 | 0.27 | 0.54 | 0.46 | 164 | 151 | 1,674 | 76,548 | 20,382 |
| 500 | 0.57 | 0.40 | 0.87 | 0.68 | 204 | 188 | 3,488 | 155,912 | 41,556 |
| 1,000 | 1.19 | 0.66 | 1.67 | 1.05 | 253 | 224 | 7,020 | 313,264 | 83,540 |
| 2,000 | 3.34 | 1.22 | 4.11 | 1.87 | 397 | 325 | 14,112 | 627,948 | 167,488 |
| 3,000 | 6.65 | 1.78 | 7.68 | 2.69 | 723 | 403 | 21,172 | 942,644 | 251,448 |

At 3,000 files the correction is 3.7× faster by wall time, uses 44% less peak
RSS, and materializes 73% fewer edges. From 1,000 to 3,000 files, corrected wall
time grows 2.70× for 3× the input; parsing grows 2.93×. The curve is therefore
near-linear. The 2,000-file fixture completes in 1.22 seconds on this machine,
well inside the provisional two-minute acceptance budget.

Work counters scale with the fixture rather than silently shrinking: symbols
grow from 7,348 to 90,504, resolution attempts from 588 to 7,612, claims from
1,674 to 21,172, and graph walks from 23 to 263. Fixed-point iterations remain
two at every size because the hazard closure stabilizes in a bounded number of
passes.

### Every measured phase (milliseconds)

| Files | State | Discover | Workspace | Parse | Resolve | Conventions | Graph | Reachability | Hazards | Claims | Evidence | Delete | Assembly |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 250 | before | 2.702 | 3.140 | 95.673 | 2.795 | 34.003 | 25.368 | 27.300 | 0.402 | 28.132 | 0 | 0 | 1.104 |
| 250 | after | 2.948 | 4.787 | 97.447 | 2.784 | 17.996 | 18.323 | 8.976 | 0.390 | 6.571 | 0 | 0 | 0.998 |
| 500 | before | 4.731 | 3.057 | 171.569 | 5.508 | 58.832 | 57.006 | 56.527 | 0.619 | 100.970 | 0 | 0 | 2.591 |
| 500 | after | 4.532 | 3.556 | 176.980 | 4.650 | 30.679 | 30.997 | 18.422 | 0.542 | 14.965 | 0 | 0 | 2.418 |
| 1,000 | before | 7.597 | 3.260 | 335.121 | 9.718 | 112.031 | 85.058 | 115.974 | 1.210 | 396.668 | 0 | 0 | 4.874 |
| 1,000 | after | 7.558 | 3.879 | 344.856 | 9.082 | 41.944 | 58.277 | 37.312 | 1.664 | 29.435 | 0 | 0 | 4.681 |
| 2,000 | before | 11.403 | 3.739 | 660.617 | 17.234 | 208.081 | 172.621 | 407.650 | 3.355 | 1,710.860 | 0 | 0 | 12.860 |
| 2,000 | after | 11.432 | 4.520 | 675.743 | 17.656 | 74.265 | 121.134 | 92.271 | 3.387 | 70.688 | 0 | 0 | 12.218 |
| 3,000 | before | 16.505 | 4.416 | 996.472 | 26.741 | 304.267 | 267.504 | 887.598 | 5.660 | 3,957.968 | 0 | 0 | 29.440 |
| 3,000 | after | 15.904 | 5.163 | 1,008.959 | 25.185 | 102.859 | 183.292 | 144.074 | 7.093 | 118.212 | 0 | 0 | 24.980 |

Graph construction and convention extraction are recorded exclusively, as are
hazard activation and claim generation. Evidence is zero in ordinary report
modes because shortest paths are generated only by `why` or test-only evidence.

## Mode-specific cost

Corrected 2,000-file cold runs:

| Mode | Wall s | CPU user+sys s | Peak RSS MB | Delete ms | Simulations |
| :--- | ---: | ---: | ---: | ---: | ---: |
| terminal report | 1.19 | 1.84 | 294 | 0 | 0 |
| `--json` | 1.18 | 1.80 | 322 | 0 | 0 |
| filtered export JSON | 1.18 | 1.77 | 325 | 0 | 0 |
| `why --delete --json` | 1.31 | 1.95 | 317 | 134.844 | 1 |
| bounded Markdown `report` | 2.38 | 3.21 | 415 | 1,211.263 | 10 |

For comparison, the legacy report path simulated all 1,674 claims on only the
250-file fixture: deletion planning took 49.55 seconds and total wall time was
50.02 seconds. Bounded report planning removes that claim-count multiplier.

## CPU profile evidence

Node CPU profiles were captured at 3,000 files with `--cpu-prof` and generated
source maps enabled. Before the correction, 4,616 samples were recorded. The
largest self-time frames were `markFile` (1,122 samples), `getNode` (419), two
`computeReachability` frames (341 and 233), garbage collection (279), and
`markSymbol` (143). Native Oxc `jsonParseAst` accounted for 180. This directly
identifies repeated JavaScript reachability work as the hot path.

After the correction, the profile fell to 1,366 samples. The leading frame was
native Oxc `jsonParseAst` (202 samples), followed by GC (109), Oxc module loading
(92), and Oxc `parseSync` (57). `markSymbol` fell to 22 samples and no
`computeReachability` frame appeared in the top fifteen. Profile artifacts stay
local under ignored `.bench-tmp/`; only this de-identified aggregate is
committed.

## Rust decision

**Decision: a Rust rewrite is unwarranted before v0.1.0.** The actual hot paths
were repeated graph work and an unbounded filesystem walk, not operations whose
constant factors needed a lower-level language. The graph costs were Θ(E²)
intra-file edge materialization and Θ(T × (V + E)) zombie walks; the filesystem
defect made work proportional to unrelated ignored tree size. After correction,
emitted edges and ordinary reachability work are linear in the represented
graph, test walks use bounded early exits, and config inventory work shares
discovery's explicit boundary. The observed end-to-end curve is near-linear.

The remaining dominant phase is parsing, and its hottest frames already belong
to the native Rust-backed Oxc parser. Resolution is also handled by the native
Oxc resolver and is small (25 ms at 3,000 files). Moving the now-bounded graph
walk across a Rust boundary would require graph serialization or a persistent
foreign-memory representation, duplicate IR types and provenance semantics,
and add implementation/release maintenance for a small fraction of corrected
runtime. Expected gain is therefore limited and boundary cost could erase it.

Reconsider an isolated native prototype only if a future, representative public
benchmark shows one bounded JavaScript operation again dominating after
algorithmic profiling. No broad Rust rewrite is justified by the current data.
