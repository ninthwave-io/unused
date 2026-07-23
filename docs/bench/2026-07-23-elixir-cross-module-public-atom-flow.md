# Elixir cross-module public atom-flow checkpoint

Date: 2026-07-23
ADR: 0014 Phase 1B2B
Base: `6153c36`
Scope: exact public parameter summaries inside one complete Mix TraceResult

## Delivered boundary

- Definition bodies keep the full module, file, partition, name, and arity
  identity established in Phase 1B2A.3.
- A separate module, partition, name, and arity index resolves a cross-file
  target only when exactly one eligible project-owned reflected definition
  exists with its own exact source file and line.
- Each admitted edge requires one parenthesized source call and one canonical
  compiler `remote` or `imported` event to join exactly. Source aliases/imports
  do not supply the identity.
- The production compile and test partition must both be complete. Dependency,
  sibling Mix, incomplete, missing, duplicate, conflicting, and wrong-world
  targets remain escapes.
- Guards, defaults, patterns, multiple clauses, generated code, unsafe module
  bundles, no-parenthesis calls, and the prior exactness rejections remain
  opaque.
- Parameter-derived returns may reach a caller-side sink. Values created and
  returned by public callees still escape; public result summaries do not
  exist, and private results remain private-only.
- The public JSON schema and canonical stdout are unchanged.

## Complexity evidence

Cross-module edges enter the existing indexed call adjacency, Tarjan SCCs,
finite monotone parameter bitmasks, delta queues, and 64-caller/callee bound.
No producer-specific traversal or second cross-module solver is added.

| Cross-file chain length | Canonical targets | Parameter slots | Cross edges | Producer matches |
| ---: | ---: | ---: | ---: | ---: |
| 250 | 251 | 252 | 250 | 1 |
| 500 | 501 | 502 | 500 | 1 |
| 1,000 | 1,001 | 1,002 | 1,000 | 1 |

Every chain retains all files, definitions, parameters, and edges, terminates
at one data sink, and has zero escape or opaque participants. Assertions bound
cross-module SCC evaluations and parameter-bit updates, plus shared role edges
and queue visits, linearly. A 65-callee multi-file hub has 67 canonical targets,
66 exact edges, one producer match, and exactly one opaque participant, yielding
the explicit function-summary bounded escape.

Two-module recursive fixtures retain three exact cross edges. A cycle with an
exact data terminal converges to data; the otherwise identical terminal-free
cycle is seeded as escape. Neither is truncated or solved per producer.

## Real-compiler evidence

The neutral safe Mix fixture has eight eligible public definitions, fifteen
parameter slots, one same-module edge, and nine exact cross-module edges.
Direct aliased, imported, caller-side pass-through, and same-module-wrapper
flows produce four data outcomes with no invocation or escape. `why` identifies
the live production path, while the unrelated dead export remains high
confidence, hazard-free, and deletion-supported.

The neutral unsafe fixture has seven eligible public definitions, seven
parameter slots, three exact cross edges, one rejected canonical defaulted
target, and one external-boundary escape. It retains one invocation and three
escapes for an unknown sink, a public-origin returned atom, and the rejected
defaulted call. `why` reports the exact production sites, and deletion of the
hazard-affected dead control is refused without consequence stages.

## Rejection matrix

Focused synthetic tests fail closed for guarded, defaulted, patterned,
multi-clause, and generated targets; wrong-world reflection or events;
duplicate target identities or compiler events; missing events; unsupported
no-parenthesis syntax; external dependencies; and incomplete TraceResults.
Canonical identity and boundary counters remain separate from standard-library
and plugin summary matches.

## Resumption point

Phase 1B2B stops at one complete Mix TraceResult. It does not authorize public
result summaries, dependency analysis, sibling Mix closure, repository merging,
or inferred source aliases. Any later expansion must first define ownership and
external-caller semantics independently of this parameter-only proof.

Before another semantic increment, preserve the unit/scaling/cycle/bound tests,
both real fixtures, `why` and deletion assertions, all language corpus gates,
generated assumptions, build/package checks, and the public privacy boundary.

## Verification transcript

The frozen implementation received an independent SHIP review with no blocker,
high, or medium findings. The final repository verification completed with:

- typecheck, dependency boundaries, generated-assumption sync, and lint green;
- 93 test files and 1,434 tests green;
- TypeScript corpus: 52 cases, 237 subjects, precision 1, recall
  0.826530612244898;
- Elixir corpus: 31 cases, 106 subjects, precision 1, recall
  0.975609756097561, zero unlabelled claims, and no skipped cases;
- Rust corpus: 4 cases, precision 1, recall 0.8333333333333334;
- polyglot corpus: 1 case, precision 1, recall 1;
- build, 10 packaging tests, and package dry-run green.

The two new Elixir cases contain thirteen explicitly labelled subjects. Their
two intended dead exports and the generated unused default wrapper are corpus
locked without relabelling any live cross-module flow as dead.
