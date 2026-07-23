# Elixir atom-flow cause-ledger checkpoint

Date: 2026-07-23
ADR: 0014 Phase 1B2B.2
Base: `bca0418`
Scope: instrumentation only; no semantic, hazard, claim, deletion, schema, or
canonical-output change

## Accounting model

Phase 1B2B.2 keeps four diagnostic universes disjoint:

1. joined escaping producers, partitioned by one local primary cause;
2. unjoined producer fallbacks, partitioned before any value-graph root exists;
3. caller-ineligible/admitted-caller-ineligible decisions, partitioned by one
   caller primary cause; and
4. every joined producer outcome, partitioned by propagated caller-eligibility
   exposure.

Local escape causes use a 22-bit mask and caller eligibility uses an 11-bit
mask. Both have independent signed-31-bit guards and remain separate from the
28-bit cross-call decision mask. Masks propagate through the existing node
queue and the existing parameter/private-result SCC arrays. There is no new
walk, producer ID set, source scan, trace scan, or semantic lattice state.

Runtime invariants prove the primary sum for each universe, the separate
unjoined sum, and that no overlap counter exceeds its universe. Module-safety
flags deliberately overlap. Counts are committed only when a producer or call
decision is finalized, never when an SCC member is reevaluated.

## Exact branch evidence

The neutral matrix exercises assignment interpolation/rebinding/unused,
unsupported return and value contexts, source cardinality, missing and
ambiguous compiler events, project and external unsummarized calls, callback
containment, omitted roles, no-caller and unsafe-caller private results,
parameter and private-result cycles, and the 64-degree bound. Separate fixtures
exercise all three unjoined causes.

Caller fixtures exercise guard, default, pattern, multiple-clause, nested
ownership, missing/duplicate/line-mismatched/world-mismatched reflection, and
real module safety from `use`, `defoverridable`, and generated source. The real
module-safety fixture retains the same data disposition while exposing only
diagnostic caller causes.

Five local fallbacks are structurally defensive in a valid indexed graph:
assignment owner missing, unclosed indexed container, unresolved balanced-call
argument, missing summary argument, and root with no outcome. Their exhaustive
records are asserted at zero rather than reached through malformed source.
`caller-source-no-paren` is also zero: the existing supported source/compiler
join cannot derive an arity from that range and records the compiler group as
`source-call-unindexed`. Adding a reverse attribution lookup was outside this
instrumentation-only checkpoint.

## Fixed-density complexity evidence

The existing callback-input generator retains one computed-atom producer, one
registered callback boundary, one joined escape, and one role omission per
generated function. Phase 1B2B.2 adds exact cause/exposure assertions without
reducing the fixture:

| Functions/producers | Joined escapes | `role-omitted` primary/overlap | Role-edge bound | Queue-visit bound |
| ---: | ---: | ---: | ---: | ---: |
| 250 | 250 | 250 / 250 | <= 2,000 | <= 2,000 |
| 500 | 500 | 500 / 500 | <= 4,000 | <= 4,000 |
| 1,000 | 1,000 | 1,000 / 1,000 | <= 8,000 | <= 8,000 |
| 2,000 | 2,000 | 2,000 / 2,000 | <= 16,000 | <= 16,000 |

The same series exercises caller attribution at fixed density: each producer
has one `multiple` exposure containing `caller-module-unsafe` and
`caller-reflection-missing`, while its producer and registered role calls
create exactly 2N caller-ineligible decisions with the same two overlap causes.
Thus the 250/500/1,000/2,000 rows also assert exact caller primaries and
overlaps rather than measuring only local escape causes.

The 2,000/250 median wall-time assertion remains below `16x + 10 ms`; exact
edge, queue, producer, escape, and cause counts are the deterministic CI
evidence. The complete focused runtime-reference suite currently contains 118
tests and completes in about 3.6 seconds on the development host.

## Semantic and deletion isolation

Semantic disposition reads only the pre-existing atom-flow outcome bits. The
new masks are not reachable from hazard emission, claim evaluation, `why`, or
deletion planning. Existing computed-atom escape hazards therefore continue to
block deletion with no consequence stages, including zero-producer and
diagnostic-only cases; cause counts are never treated as deletion evidence.

## Resumption point

Preserve the four accounting universes, three independent mask bounds, exact
primary sums, no-rescan/no-walk propagation, defensive zero controls, canonical
stdout purity, and privacy boundary. Any attempt to attribute no-parentheses
or currently unindexed compiler events needs a separately reviewed source/event
join design and is not authorized by this checkpoint.
