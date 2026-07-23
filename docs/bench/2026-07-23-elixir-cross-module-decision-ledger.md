# Elixir cross-module decision-ledger checkpoint

Date: 2026-07-23
ADR: 0014 Phase 1B2B.1
Base: `e0d7441`
Scope: instrumentation only; no claim, hazard, explanation, deletion, schema, or
canonical-output change

## Delivered accounting boundary

The cross-module public atom-flow admission path now records four deliberately
separate universes:

1. raw function-scoped compiler cross-call records, exact-key groups, and
   duplicate records;
2. indexed source-call/world join attempts and their join, source-cardinality,
   missing-event, or ambiguous-event outcomes;
3. canonical target identities and their eligibility outcomes; and
4. unique call-site decisions, each with one disjoint first-outcome reason.

Admitted edges are partitioned into summary dependency edges and event-level
edges from non-summary callers. Module-safety flags are overlapping call-
weighted observations rather than a fifth disjoint decision universe.
`source-call-unindexed` is intentionally narrow: an owned compiler cross-event
group had no supported indexed source call. It does not guess that the source
used no-parentheses syntax or any other particular construct.

Runtime invariants prove:

- decision reasons sum to unique decisions;
- eligibility reasons sum to target identities;
- source-join reasons sum to join attempts;
- raw compiler records equal groups plus duplicates;
- target-rejection decisions equal the legacy canonical-rejection total;
- incomplete/unknown boundary decisions equal the legacy boundary-escape
  total;
- admitted decisions equal admitted edges; and
- admitted edges equal dependency plus non-summary-caller edges.

## Producer attribution without walks

Each value node carries a diagnostic reason mask beside the existing semantic
outcome. The same reverse graph queue propagates both. Parallel masks on public
and private parameter summaries and private result summaries converge through
the existing SCC delta queues. No producer retains decision IDs, no graph is
cloned, and no attribution traversal is run after solving.

The reason vocabulary currently uses 28 bits and is guarded below the signed
31-bit bound. An escaping producer with no propagated reason is
`unattributed`, one reason is attributed directly, and two or more reasons are
`multiple`; overlap counters retain each constituent reason. These diagnostic
bits are never read by semantic flow, hazard activation, claims, `why`, or
deletion planning.

## Fixed-density complexity evidence

The existing generated cross-file chain retains one function and one source
file per step, one admitted edge per transition, one computed-atom producer,
and one terminal standard-library consumer. The ledger adds exact linear
counts without reducing semantic density:

| Files in chain | Compiler records/groups | Source joins | Target identities | Decisions | Admitted/dependency edges |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 250 | 252 | 252 | 251 | 252 | 250 |
| 500 | 502 | 502 | 501 | 502 | 500 |
| 1,000 | 1,002 | 1,002 | 1,001 | 1,002 | 1,000 |

All compiler duplicate, source ambiguity, non-summary edge, producer escape,
and opaque-participant counts remain zero in this accepted series. The focused
Vitest run completed the three sizes in 0.331 seconds of test time (0.599
seconds total process duration on the development host). Timing is supporting
evidence only; exact counters enforce the complexity contract in CI.

The rejected-target series independently retains 250, 500, and 1,000 distinct
caller files plus the same number of distinct `use`-bearing target files. At
size N it records exactly 2N compiler groups, 2N source joins, 2N target
identities, N `dynamic-delegated` decisions, N `target-module-safety`
decisions, N `use` flags, N attributed producer escapes, and zero admitted
edges. Module owners/worlds, module presence, reflection identities, and source
ranges are indexed during construction, so classification performs no
per-rejected-identity whole-trace or whole-source scan. Role-edge and queue-
visit assertions remain bounded by constant multiples of N.

## Exact rejection and propagation evidence

The synthetic rejection matrix covers guarded, defaulted, patterned,
multi-clause, unsafe-module, wrong-world, wrong-partition, unowned-caller,
duplicate-target, missing-event, duplicate-event, unsupported-source,
external-boundary, and incomplete-boundary outcomes. Every row asserts the
complete decision, compiler, source, target, edge, module-safety, legacy, and
producer tuples. Separate cases prove source-cardinality ambiguity, an admitted
event-level edge from a non-summary caller, multiple propagated reasons through
a public parameter, and the same propagation through a private result summary.
Absent names, same-name wrong arities, public macros, and private wrong-arity
definitions have distinct source/arity outcomes; classification never borrows
the shape of a different arity. Incomplete internal, incomplete external,
failed-compile, overlapping module-safety, cyclic diagnostic convergence,
direct private-parameter, and production/test-world accounting are explicit.

The neutral real-compiler fixture uses an independently authored controller-
shaped `use` boundary. It attributes the conservative producer escape to
`target-module-safety` with the overlapping `use` flag. The application path
and consumer remain alive, the unrelated export remains the same medium-
confidence dead control, `why` retains the exact escape site, and deletion
planning remains unsupported with no stages. Mixed-plugin composition must
produce the identical Elixir claim set.

A second real-compiler fixture puts `use` on the caller itself. Direct source
calls, including a final `defoverridable` replacement, remain event-level
`admitted-caller-ineligible` edges and never enter caller summary adjacency.
Calls emitted only by `use`, including a generated private carrier, remain
unindexed and produce conservative carrier-scoped escape hazards and deletion
refusal. This is the narrow proof supported by file/line compiler provenance;
the ledger does not claim final generated-clause provenance.

## Resumption point

This checkpoint authorizes observation, not a new semantic rule. Preserve the
four accounting universes, exact legacy equalities, finite-mask guard,
fixed-density series, neutral compiler fixture, canonical stdout purity, and
privacy boundary before changing cross-module eligibility. Any later semantic
increment needs its own independently reviewed proof and fixture.

## Verification transcript

The corrected frozen implementation received an independent SHIP review with
no blocker, high, or medium findings. Final verification completed with:

- typecheck, lint, dependency boundaries, and generated-assumption sync green;
- focused atom-flow units: 104/104; real Elixir hazard integrations: 38/38;
- full ASDF-backed suite: 93 files and 1,452 tests green;
- TypeScript corpus: 52 cases, 237 subjects, precision 1, recall
  0.826530612244898;
- Elixir corpus: 33 cases, 115 subjects, precision 1, recall
  0.9767441860465116, with zero false positives, confidence violations,
  unlabelled claims, or skipped cases;
- Rust corpus: 4 cases, precision 1, recall 0.8333333333333334;
- polyglot corpus: 1 case, precision 1, recall 1; and
- build, 10 packaging tests, and package dry-run green.
