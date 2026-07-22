# 0014 — Typed Elixir computed-value flow and explicit hazard scope

Date: 2026-07-22
Status: Accepted (phases 1A and 1B1 implemented; later phases pending)

## Context

The Elixir compiler tracer identifies the static callee of calls such as
`String.to_atom/1` and `String.to_existing_atom/1`. It does not report how the
returned atom is subsequently consumed. The frontend currently marks these
calls as dynamic-dispatch proxies because an immediate computed receiver can
invoke a function without producing a second useful compiler event.

That conservative proxy conflates two different facts:

- a known static function produced an atom value; and
- a runtime operation used a computed value to select executable code.

Source-role recognizers can discharge some data-only uses, but extending a list
of complete syntactic shapes is not a sustainable architecture. Equivalent
assignments, containers, clauses, pipelines, or helper calls otherwise remain
opaque even when the computed atom cannot select code. Conversely, suppressing
the producer unconditionally would be unsound when the value reaches
`apply/3`, a computed receiver, a capture, an MFA value, or an unknown escape.

The current fallback also has a deliberately broad downstream effect. An
active `elixir-dynamic-dispatch` annotation whose `affectedSymbols` field is
absent uses the registry's `project` scope, where project means the workspace
unit owning the carrier rather than the whole repository. Every claim in that
unit is capped at medium confidence. Deletion planning checks hazard effects
before graph simulation, so `why --delete` refuses every affected subject
immediately and emits no consequence stages. A bounded target set is narrower:
only the named symbols, their executable symbol descendants, and their
containing-file deletion claims are affected.

Activation is also broader than the source facts sometimes warrant. Public
functions can be exact carrier symbols, but private functions are not graph
nodes and fall back to their whole file. Hazard annotations do not retain the
production, config, or test partition, and evaluation starts from the union of
all three reachable sets. These choices are fail-safe but can turn a local,
test-only, or unreachable uncertainty into a unit-wide deletion refusal.

ADR 0013 requires language and convention support to be modular. This decision
therefore defines a general value-flow and hazard contract rather than adding
more project-shaped recognizers.

## Options considered

- **Keep adding complete source-shape recognizers.** This gives small,
  reviewable corrections but duplicates binding and consumer reasoning across
  roles. Coverage grows by syntax rather than semantics and ambiguity remains
  difficult to explain. Rejected as the long-term design; existing recognizers
  remain valid regression coverage during migration.
- **Treat every static atom producer as data-only.** Simple and fast, but
  unsound for computed receivers, `apply`, captures, MFA values, and escaped
  values. Rejected.
- **Keep every unresolved producer as workspace-wide dynamic dispatch.** Sound,
  but it conflates value creation with invocation, hides unrelated findings,
  and makes deletion planning unnecessarily unusable. Rejected as the steady
  state; retained as the rollback and fail-closed fallback until each phase is
  proven.
- **Build a full general Elixir interpreter or path-sensitive type system.** It
  could model more programs, but macro expansion, path explosion, and ongoing
  language maintenance are disproportionate to the required safety boundary.
  Rejected.
- **Use a bounded typed value-flow analysis with declarative semantic
  summaries.** This distinguishes producers, propagation, data sinks,
  invocation sinks, and escapes while keeping uncertainty explicit and
  indexed. Chosen.

## Decision

### Separate computed values from invocation

The Elixir frontend will represent a compiler-confirmed static atom producer as
a typed **computed-atom fact**. Producing an atom does not itself create a
dynamic-invocation hazard.

The fact is propagated through a bounded local value-flow graph until it reaches
one or more classified consumers:

- a proven data sink discharges the invocation concern for that flow;
- a literal or otherwise exact invocation sink emits a runtime-resolved graph
  edge;
- a bounded invocation sink emits an explicit affected-symbol set;
- a truly opaque invocation sink emits a unit-scoped dynamic-invocation hazard;
  and
- an unknown call, return, store, or other unmodelled escape emits an explicit
  computed-value escape hazard.

An escape hazard is not described as a proven invocation. It records that the
analyzer lost the value before proving that it was data-only. It remains
fail-closed and may retain a unit effect when no narrower target is justified.
True opaque dispatch remains unit-scoped. No rule may turn an unknown sink into
no hazard merely because its producer callee was static.

The initial value lattice is finite and intentionally small: ordinary value,
computed atom, module selector, function selector, MFA component, and unknown.
Joins only move toward uncertainty. New states require neutral fixtures and a
documented effect on sinks; they are not inferred from a consuming project.

### Indexed per-function role and def-use IR

Each compiler-owned source is lexed and indexed once. Within each function or
module region, the frontend constructs a lightweight role/def-use IR containing
only the structures needed for bounded flow:

- compiler-confirmed call sites and source spans;
- versioned local definitions and uses;
- assignments and rebinding boundaries;
- tuple, list, and map fields;
- call and pipeline argument positions;
- clause, guard, branch, return, and escape boundaries; and
- explicit invocation-role positions for receiver, module, function, arity,
  capture, and MFA values.

The analysis is not a general evaluator. It propagates lattice values over
indexed edges with a work queue. Ambiguous compiler/source cardinality,
unsupported rebinding, a value crossing an unmodelled boundary, or an
unclassified consumer fails closed as an escape or invocation hazard.

### Declarative semantic summaries

Known callees and conventions contribute declarative summaries rather than
claim or deletion behavior. A summary identifies argument and result roles such
as:

- data-only;
- lossless propagation;
- module selector;
- function selector;
- capture or MFA component;
- invocation sink; or
- unknown escape.

The Elixir language frontend owns summaries for language and standard-library
semantics. Convention plugins own framework-specific summaries under ADR
0013's typed plugin contract. The shared hazard evaluator, claim engine,
`why`, and deletion planner remain language-agnostic. A plugin may contribute
facts and roles but may not silently suppress claims or bypass the hazard
registry.

Summary matching uses exact callee identity, arity, carrier, partition, and
source/event cardinality. A missing, conflicting, or ambiguous summary match
uses the conservative fallback.

### Exact carriers and explicit effects

The graph will represent private functions, macros, or equivalent function
regions as non-claimable internal carrier nodes. Static reachability may enter
these nodes, but they never become public unused-export claims. A dynamic fact
activates from its actual region instead of from the containing file whenever
compiler ownership is available.

Hazard annotations will separate three concepts that are currently partly
encoded by optional fields:

1. the activation carrier;
2. propagation to executable targets; and
3. the confidence/deletion effect scope.

Effect scope is an explicit tagged value:

- `{ kind: "symbols", ids: [...] }` for bounded targets;
- `{ kind: "file", file: ... }` for file-local uncertainty; or
- `{ kind: "unit", root: ... }` for an opaque boundary.

The annotation also carries the production, config, or test world in which the
fact exists. Hazard evaluation preserves worlds rather than discarding them
into one activation union. Claim confidence uses only applicable worlds.
Deletion planning considers every world in which removing the subject could be
unsafe, including tests, and explains which world supplied the blocker.

During migration, absence of an explicit effect scope is interpreted exactly
as today: the registered fallback scope applies. This preserves safety and
provides a one-step rollback.

### Explanation and deletion behavior

`why` distinguishes at least these cases:

- an exact runtime target and its provenance path;
- a bounded dynamic invocation and its affected target set;
- an opaque invocation that can select code in a stated scope; and
- a computed value that escaped before its use could be classified.

It also identifies the carrier and applicable world. Explanations do not claim
that value production invoked code.

`why --delete` and `--fix` continue to refuse a subject affected by an active
opaque invocation or unresolved escape. Bounded hazards refuse only their
affected symbols, executable descendants, and containing files. Exact edges use
ordinary inbound-reference and consequence planning.

A later deletion-planner phase may re-evaluate hazards counterfactually when
the requested deletion removes the hazard carrier itself. It must first remove
the exact carrier and its annotation from the simulated graph, recompute
world-specific activation, and retain every surviving hazard. Until that is
proved, the existing early refusal remains the safe behavior.

### Complexity contract

Source indexing and local propagation must be
O(source bytes + compiler events + role/def-use edges + emitted candidates),
with memory O(indexed source facts + role/def-use edges). No producer or claim
may rescan an entire source file or graph.

If interprocedural flow becomes necessary, functions expose finite summaries
such as “argument 1 reaches an invocation” or “result carries a computed atom”.
Summaries converge through call-graph strongly connected components using a
monotone fixed point. Cost is bounded by call edges multiplied by the finite
lattice height; the implementation must not clone state per call path.

Alias sets, container fields, and branch joins have explicit size limits.
Exceeding a limit becomes unknown escape, never truncated certainty. Performance
instrumentation records indexed sources, producers, role edges, work-queue
visits, summary iterations, exact/bounded/opaque sinks, and escapes.

## Implementation phases and rollback

1. **Facts and characterization.** Add neutral tests that distinguish atom
   production, data use, exact/bounded/opaque invocation, and escape. Introduce
   explicit internal fact types without changing emitted hazards. The current
   unit fallback is the oracle for conservative behavior. Phase 1A records the
   originating worlds as effect provenance but intentionally retains unioned
   activation; world-specific filtering begins only in phase 4 after its
   false-positive safety fixtures exist.
2. **Local indexed flow.** Build the per-function IR and migrate existing
   source-role proofs behind declarative summaries. Compare old and new facts;
   any disagreement remains opaque until independently reviewed.
3. **Invocation and escape split.** Emit separate dynamic-invocation and escape
   hazards with explicit effect scopes. Keep the legacy dynamic-dispatch
   projection behind an internal rollback switch until corpus and deletion
   tests pass.
4. **Internal carriers and worlds.** Add private/function-region carriers and
   partition-aware activation. Verify that removing broad activation does not
   make a live subject claimable.
5. **Explanation and deletion.** Update `why`, deletion refusal, and only then
   optional carrier-removal counterfactuals. Generated assumptions and schemas
   change in the same atomic milestone when public output changes.
6. **Interprocedural summaries only if required.** Add SCC-based summaries for
   neutral cases that cannot be handled locally. Do not add context-sensitive
   path exploration.

Each phase is independently revertible. The rollback is to project current
facts into the existing `elixir-dynamic-dispatch` annotation and its
carrier-reachable unit cap. Rollback may reduce precision and deletion support;
it may never reduce safety.

### Phase 1B1 implementation checkpoint

The first local-flow slice is implemented as a source-local indexed value-role
graph. All producers on one exact carrier and partition share container,
assignment, call-role, and use nodes. A finite outcome bitmask converges over
reverse edges with a delta queue, so each node changes only a bounded number of
times rather than rewalking shared suffixes per producer. Its reviewed
declarative registry is sparse and exact by canonical
module, function, and arity. Source calls must have unique source cardinality
and unique compiler-event corroboration on the same carrier and partition;
aliases and imports use the compiler's canonical callee. Core summaries are
disabled when the project owns the named core module. Ecto summaries are owned
by a typed provider on the registered built-in `convention:ecto` plugin. The
provider is applied before graph emission only when `ecto` is a compiler-known
dependency, and is disabled when the project owns the summarized Ecto module.

This slice covers standard `Map`, `Keyword`, `MapSet`, `Atom`, and `Enum`
data/propagation roles plus an intentionally small public `Ecto.Changeset` and
`Ecto.Type` surface. It follows simple versioned locals, assignments, literal
containers and allowlists, pipelines, `with` bindings, and exact literal
callback result expressions. Invocation receivers, `apply`, captures, MFA
selector positions, Ecto type selectors, unknown calls or returns, rebinds,
interpolation, and ambiguous cardinality remain conservative. Omitted summary
arguments are escapes, never inferred safe.

The four legacy exact recognizers remain enabled through the same final
classification result so previously accepted data-only cases do not regress
while the generic engine grows. Invocation and unknown-use evidence takes
precedence over that compatibility terminal. There is no same-module or
cross-module function-summary propagation in Phase 1B1; that remains phase 6
and requires separate evidence.

The implementation exposes deterministic internal counters for sources,
source bytes, producers, role edges, queue visits, matched summaries, data and
invocation sinks, and escapes. One event-populated 250-to-1,000-function
fixture holds independent semantic density constant. A second adversarial
fixture puts P producers in one assigned container with U later consumers and
asserts unique-edge and queue-visit bounds proportional to P + U, preventing
the former P × U traversal from returning. Independent real Mix fixtures prove
data-only deletion support, returned-value escape refusal, and bounded apply
refusal without cross-contaminating their units. No public report or JSON
schema changes in this slice.

## Acceptance

Implementation is complete only when all of the following hold:

1. Independently authored neutral fixtures label original live and dead
   subjects for data-only atom use, computed receiver calls, `apply/3`,
   captures, MFA tuples, unknown calls, returns, containers, rebinding,
   branches, and private carriers.
2. Exact and bounded sinks retain real runtime edges or affected-symbol scopes;
   opaque sinks and escapes remain fail-closed. No project-wide blanket
   suppression hides unrelated true positives.
3. Production, config, and test cases prove world-specific activation. Deletion
   remains blocked whenever any applicable world can reference the subject.
4. `why` describes the actual value flow, sink or escape, carrier, and world.
   `why --delete` refuses uncertain live subjects and supports unrelated dead
   subjects with accurate consequence stages.
5. Elixir corpus precision remains 1.0 with recall reported. TypeScript, Rust,
   and polyglot corpus gates do not regress.
6. Synthetic scaling fixtures exercise increasing sources, producers, uses,
   edges, sinks, and escapes without reducing semantic density. Timings and
   counters demonstrate the complexity contract and no material peak-memory
   regression.
7. Typecheck, lint, boundaries, unit/integration tests, generated-assumption
   sync, build, packaging smoke, and privacy scan are green.
8. A separate consuming-project run completes within its accepted interactive
   budget, every reported deletion is reviewed through its language and bridge
   boundaries, and no in-use functionality is removed. Only aggregated,
   de-identified acceptance status returns to this public repository.

## Privacy boundary

This decision and its implementation use only public language/framework
conventions and independently generated neutral source. No private project
name, path, source, symbol, configuration, artifact, raw analyzer output,
process sample, or prose may be accessed, copied, quoted, or committed.
Public filenames, comments, fixtures, benchmarks, commits, PR text, and issue
text remain de-identified. Consumer validation is performed separately; its
contents do not become public test data.

## Consequences

- Atom production is no longer semantically described as invocation, while
  unknown use remains conservative.
- Framework knowledge becomes modular role metadata instead of accumulating in
  frontend-local complete-shape recognizers.
- The graph gains internal carrier nodes and world-aware hazard data, increasing
  node count and evaluation state by a bounded linear amount.
- Hazard annotations and explanations become more explicit; schema or generated
  assumption updates may be required when those fields become public.
- The design improves unrelated-claim and deletion precision without promising
  whole-program Elixir interpretation.
- A broad Rust rewrite is neither required nor authorized by this decision. A
  native implementation remains justified only by profiling a bounded hot path
  after the algorithmic correction.
