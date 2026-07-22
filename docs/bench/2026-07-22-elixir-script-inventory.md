# Elixir standalone-script inventory benchmark

Date: 2026-07-22
Runtime: Node 22.16.0
Command: `node packages/unused/scripts/benchmark-elixir-script-references.mjs`

## Scope

This benchmark isolates the new static extraction step after repository
discovery. It generates neutral temporary `.exs` files with literal aliases,
same-line calls containing anonymous functions, multiline calls containing
nested delimiters and anonymous functions, MFA tuples, and one resolvable exact
script load per file, then removes the temporary tree. It does not invoke Mix
and is not presented as an end-to-end compiler benchmark.

The implementation reads every visible standalone script once, builds module
and function indexes once, scans source text linearly, and resolves source
locations with binary search over line starts. Expected complexity is
O(total bytes + literal references × log(lines)); memory is O(files + bytes +
emitted facts). Parenthesized call arities are indexed in one position-stable
delimiter/block pass; nested call bodies are not rescanned for each outer call.
The fixture never reduces reference density at larger sizes.

## Result

Seven warm repeats were run for each independently generated size; the table
reports the median extraction time.

| Files | Bytes | Reference edges | Resolution attempts | Median |
| ---: | ---: | ---: | ---: | ---: |
| 250 | 85,250 | 4,250 | 5,250 | 14.892 ms |
| 500 | 170,500 | 8,500 | 10,500 | 28.192 ms |
| 1,000 | 341,000 | 17,000 | 21,000 | 56.215 ms |
| 2,000 | 682,000 | 34,000 | 42,000 | 111.218 ms |
| 4,000 | 1,364,000 | 68,000 | 84,000 | 228.158 ms |

Doubling input size approximately doubles work and elapsed time across the
series. At 4,000 files the bounded extractor remains 228 ms on this host, far
below Mix compiler startup and trace time. No native rewrite is warranted for
this operation; future work should profile the complete frontend again before
changing that decision.

The review also required a one-file, many-module adversarial series. Line starts
are computed once per file, so module discovery does not rescan the entire file
for every `defmodule`.

| Modules in one script | Bytes | Median |
| ---: | ---: | ---: |
| 250 | 9,389 | 0.899 ms |
| 500 | 18,889 | 1.828 ms |
| 1,000 | 37,889 | 3.567 ms |
| 2,000 | 76,889 | 7.482 ms |
| 4,000 | 154,889 | 14.357 ms |

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
