# Elixir standalone-script inventory benchmark

Date: 2026-07-22
Runtime: Node 22.16.0
Command: `node packages/unused/scripts/benchmark-elixir-script-references.mjs`

## Scope

This benchmark isolates the new static extraction step after repository
discovery. It generates neutral temporary `.exs` files with literal aliases,
remote calls, MFA tuples, and one resolvable exact script load per file, then removes the temporary
tree. It does not invoke Mix and is not presented as an end-to-end compiler
benchmark.

The implementation reads every visible standalone script once, builds module
and function indexes once, scans source text linearly, and resolves source
locations with binary search over line starts. Expected complexity is
O(total bytes + literal references × log(lines)); memory is O(files + bytes +
emitted facts). The fixture never reduces reference density at larger sizes.

## Result

Seven warm repeats were run for each independently generated size; the table
reports the median extraction time.

| Files | Bytes | Reference edges | Resolution attempts | Median |
| ---: | ---: | ---: | ---: | ---: |
| 250 | 49,000 | 3,000 | 3,750 | 10.352 ms |
| 500 | 98,000 | 6,000 | 7,500 | 20.468 ms |
| 1,000 | 196,000 | 12,000 | 15,000 | 39.786 ms |
| 2,000 | 392,000 | 24,000 | 30,000 | 81.390 ms |
| 4,000 | 784,000 | 48,000 | 60,000 | 163.560 ms |

Doubling input size approximately doubles work and elapsed time across the
series. At 4,000 files the bounded extractor remains 164 ms on this host, far
below Mix compiler startup and trace time. No native rewrite is warranted for
this operation; future work should profile the complete frontend again before
changing that decision.

The review also required a one-file, many-module adversarial series. Line starts
are computed once per file, so module discovery does not rescan the entire file
for every `defmodule`.

| Modules in one script | Bytes | Median |
| ---: | ---: | ---: |
| 250 | 9,389 | 0.678 ms |
| 500 | 18,889 | 1.273 ms |
| 1,000 | 37,889 | 2.664 ms |
| 2,000 | 76,889 | 5.181 ms |
| 4,000 | 154,889 | 10.776 ms |

Both series grow with input facts rather than multiplying files or modules by
the full inventory. The resolvable-load membership set is built once, not once
per literal. Repository carrier extraction
is separately cached once per orchestration context and filtered per Mix
fragment, avoiding a repository walk per boundary.

## Precision controls

- discovery supplies only gitignore-visible repository paths;
- compiler-traced, config, test, and Mix-owned sources are excluded;
- exact workflow/Taskfile commands, executable mode, shebang, and `Mix.install`
  root only their named script;
- `.formatter.exs`, `.iex.exs`, and matching-dependency Ecto/Phoenix migration
  or seed paths are exact roots, while adjacent arbitrary `priv` scripts are not;
- arbitrary unrooted scripts remain claimable;
- script-defined modules and opaque invocation cap only their file at medium;
  and
- literal inbound edges remain in the graph even when their source script is
  dead, so single-target deletion planning fails closed.
