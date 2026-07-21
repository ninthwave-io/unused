# Polyglot acceptance benchmark — 2026-07-21

This benchmark uses only the independently constructed public fixture at
`fixtures/polyglot/rustler-literal`. No consuming-project identifiers, paths,
source, symbols, configuration, artifacts, output, or prose were used.

## Method

- Machine: Apple M4 Pro, arm64, macOS/Darwin 25.3.0.
- Runtime: Node 22.16.0; Elixir 1.20.2 / OTP 29; stable Cargo/rustc 1.94.0.
- Input: a `git archive` copy of tracked fixture files in a new temporary
  directory. No Mix `_build` or Cargo `target` state is present.
- Command: `node packages/unused/dist/cli/index.js --performance --json --cwd
  FIXTURE`, wrapped by `/usr/bin/time -lp`.
- Canonical stdout is parsed independently as JSON. Performance NDJSON and
  external resource measurements are stderr-only.

This is a cold integration acceptance check, not a scaling curve. The neutral
TypeScript 250–3,000-file before/after curve is recorded separately in
`docs/bench/2026-07-21-scaling-investigation.md`.

## Result

| Measure | Result |
| :--- | ---: |
| Wall time | 1.01s |
| External user + system CPU | 1.41s |
| External peak RSS | 132.9MB |
| Node-reported user + system CPU | 0.188s |
| Node-reported peak RSS | 91,344KiB |
| Files / symbols / edges | 5 / 12 / 37 |
| Claims / workspaces | 2 / 3 |
| Graph walks / fixed-point iterations | 9 / 5 |
| Deletion-plan simulations | 0 |

The external CPU/RSS figures include the compiler children; Node's
`process.resourceUsage()` summary covers the analyzer process and is therefore
reported separately rather than conflated with the end-to-end measurement.

| Phase | Milliseconds |
| :--- | ---: |
| Discovery and gitignore | 2.550 |
| Workspace/config detection | 18.952 |
| Compiler/parsing | 879.456 |
| Module resolution | 0 |
| Convention/config roots | 2.118 |
| Graph construction and bridge contribution | 1.012 |
| Reachability partitioning | 0.541 |
| Hazard activation | 0.096 |
| Claim generation | 1.052 |
| Shortest-path evidence | 0 |
| Deletion planning | 0 |
| JSON assembly | 0.049 |

Zero module-resolution work is expected because this fixture contains Elixir
and Rust only. Shortest-path and deletion phases are zero in ordinary canonical
JSON by design. Counters prove the run did not remove its two planted dead
subjects to become faster.

## Interpretation

The required compiler work accounts for almost all measured phase time. The
combined convention, graph, reachability, hazard, and claim tail is under 5ms.
This supports the existing decision not to move the corrected bounded graph
core across a Rust serialization boundary before v0.1.0. The Rust frontend
continues to use stable Cargo/rustc contracts, and TypeScript parsing/resolution
already uses native Oxc components.

