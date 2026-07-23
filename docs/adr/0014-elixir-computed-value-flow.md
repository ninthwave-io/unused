# 0014 — Typed Elixir computed-value flow and explicit hazard scope

Date: 2026-07-22
Status: Accepted (through phase 1B2B; later phases pending)

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
invocation sinks, escapes, joined producer outcomes, unjoined opaque
fallbacks, and legacy/indexed classification disagreements. The position-stable
delimiter pass treats a literal `fn ... end` as nested relative to its enclosing
call, so callback pattern and body commas do not inflate compiler-joined call
arity. This includes multi-argument and multi-clause callbacks, nested `fn`
blocks, and piped receiver arity; the keyword key `fn:` remains ordinary syntax
and does not open a block. `Enum.reduce/3` is included in the reviewed core
registry with exact callback-result propagation. Its enumerable and
accumulator arguments remain omitted fail-closed roles because both flow into
arbitrary callback inputs, which this phase does not summarize.

One event-populated 250-to-1,000-function fixture holds independent semantic
density constant. A callback-heavy 250-to-1,000-function fixture alternates
explicit and piped `Enum.reduce/3`, with compiler events and nested callback
commas at every site. A dense 250-to-1,000-clause single-function fixture
guards the indexed binary search for the containing and next callback arrows,
preventing producer-by-clause rescans. A second adversarial
fixture puts P producers in one assigned container with U later consumers and
asserts unique-edge and queue-visit bounds proportional to P + U, preventing
the former P × U traversal from returning. Independent real Mix fixtures prove
data-only deletion support, returned-value escape refusal, and bounded apply
refusal without cross-contaminating their units. No public report or JSON
schema changes in this slice.

Retaining every site and a site-specific reason on one coalesced
same-carrier/world escape is deferred. The current dynamic fact and hazard
evidence shapes carry one site and one generic reason; broadening those shapes
would exceed this arity-index correction and needs a separately reviewed
diagnostic-evidence design. The existing unit scope, world activation, cap, and
fail-closed behavior are unchanged.

### Phase 1B1.2 callback-input registry audit

Implemented as a public-semantics audit against Elixir 1.20.2 and Ecto 3.14.1.
Every one of the 18 core summaries with an explicit callback now records the
callback argument, every logical input position that may enter it, the result
disposition, and a version-pinned official documentation URL. Validation
rejects unknown result roles, result/audit mismatch, duplicate or invalid input
positions, and any callback-fed input that retains an optimistic data or
propagation role. Zero-arity lazy callbacks retain their precision because they
receive no API input.

Implicit callbacks and protocol boundaries use the same fail-closed contract.
`Enum.flat_map/2` callback results are re-enumerated, `Enum.reduce/3` results
feed the next callback accumulator, and `Enum.into/3` transform results enter
an arbitrary collector, so all three result positions escape until those
boundaries are proven. `Enum.into/3` also omits both its transform-fed
enumerable and its arbitrary `Collectable` input. The one-argument `Map.new`,
`Keyword.new`, and `MapSet.new` forms omit their `Enumerable` inputs;
`Enum.member?/2` and `Enum.into/2` omit every input passed across their
`Enumerable`/`Collectable` protocol boundaries. The registered Ecto provider
records custom-type callback inputs for `Changeset.change/1,2`, `cast/3,4`,
`put_change/3`, and
`validate_inclusion/3,4`, plus every registered `Ecto.Type` dispatcher.
Dynamic type positions remain invocation selectors; callback-fed values are omitted.
Ecto entries that perform direct storage or lookup retain their reviewed roles.
Absent lazy/get-and-update variants remain absent rather than being inferred.
The Ecto provider activates only when `ecto` is declared and an unambiguous Hex
entry in `mix.lock` records the audited version `3.14.1`. Missing locks,
path/git dependencies, malformed or duplicate entries, and other versions omit
the provider and fail closed.

The established exact source proof for `Enum.map/2 |> Enum.into(%{})` remains a
compatibility terminal: it proves both the list enumerable produced by
`Enum.map/2` and the literal built-in map collector. Only that independently
validated shape may satisfy an omitted implicit-protocol role; arbitrary
enumerables and collectables still escape.

Neutral compiler-event tests cover exact zero-arity callback results,
explicit and piped callback-fed escapes, multi-clause results, Map and Keyword
merge/new, Map get-and-update, MapSet transforms, Enum into, protocol selector
escapes, Ecto alias/import/change/type-selector behavior, dependency/version
gating, project-owned spoofing, and duplicate cardinality. The real Mix Map and
Keyword fixtures end at reviewed data sinks so the former optimistic roles
would fail the assertions; the Enum fixture remains executable-shaped. An
event-populated 250, 500, 1,000, and 2,000-site series holds callback-input
escape density constant, asserts role-edge and queue-visit bounds per site, and
remains bounded by the existing indexed node/edge algorithm. This checkpoint
adds metadata and fail-closed roles only: it does not add callback binder edges,
local return summaries, or interprocedural propagation.

### Phase 1B2A implementation checkpoint

The first interprocedural slice is limited to exact same-module private
functions. A candidate must be one unambiguous top-level `defp`, use an exact
parenthesized list of distinct variable parameters, and have compiler evidence
for its carrier or local target identity in the same file and partition. Calls
join by exact caller, name, arity, source line, partition, and unique source and
event cardinality. Public functions, cross-module calls, default arguments,
multiple clauses, missing or duplicate events, and generated or otherwise
ambiguous definitions remain escape boundaries.

Identity confirmation alone cannot prove that a macro did not generate an
additional private clause. Therefore any unreviewed source construct or
compiler event at module scope disables private summaries for that module.
Phase 1B2A.1 replaces the initial callee-only allowlist with an exact source and
compiler join. Ordinary `def`/`defp` scaffolding, `@moduledoc`/`@doc` metadata,
and the reviewed typespec attributes are accepted only when the direct module
body contains that exact construct and the compiler emits the complete expected
event multiset at the same file, line, module, and partition. The implementation
does not infer safety from `Module.__put_attribute__/5`,
`Kernel.Typespec.deftypespec/6`, or another inert-looking callee alone.

Phase 1B2A.2 admits three more exact inert source classes. Direct-body `alias`,
`import`, and `require` are lexical directives according to the official
[`Kernel.SpecialForms`](https://hexdocs.pm/elixir/1.20.2/Kernel.SpecialForms.html)
contract, so a declaration is accepted only when its module and every allowed
option are independently parsed literal syntax on that line. This does not
extend to `use`, whose documented contract injects code into the caller.
Custom attributes are accepted only when a line-bounded recursive parser
consumes the complete right-hand side as strings/charlists without
interpolation, atoms, booleans, nil, numbers, or nested list/tuple/map/keyword
data, with at most 32 nested containers. Bare module aliases, calls, macros,
comprehensions, quote/unquote, structs, deeper nesting, and all residual syntax
fail closed.

The literal parser also admits the audited built-in Kernel data sigils
`~w`/`~W`, `~s`/`~S`, `~D`, `~T`, `~N`, and `~U`, following the
official [`Kernel`](https://hexdocs.pm/elixir/1.20.2/Kernel.html) contracts for
word, string, and calendar values. Lowercase interpolating forms are
accepted only when no unescaped interpolation is present. Every accepted sigil
must join exactly one canonical compiler event for its exact
`Kernel.sigil_*/2` identity in addition to the exact attribute bundle. Calendar
sigils must also join their exact `Date`, `Time`, `NaiveDateTime`, or `DateTime`
struct-expansion event. A custom owner, missing event, duplicate event,
unsupported sigil, or extra event rejects the entire module. Direct `use`,
compile hooks including `@after_verify`, quoted/generated
definitions, custom or DSL macro calls, executable attributes, and unknown
declarations remain opaque. An event attributed to another source file, an
unknown event, a missing event, an extra event, or ambiguous source cardinality
also rejects the entire module. Production rejection is inherited by the test
world. When trace merging removes exact test re-emissions, an empty test
module-event set may inherit only an already-safe production classification;
any surviving test module event requires its own complete bundle. This retains
the invisible-sibling boundary while allowing reviewed literal configuration.

Each eligible parameter has a finite data, invocation, escape, delegated-
invocation, or return effect. Return effects are joined across every exact
caller; one unsafe caller makes the return unsafe. Container propagation keeps
the producer-specific relation, and argument effects remain indexed by
parameter, so an invocation role in one argument does not contaminate a data
role in another. Production and test definitions have distinct identities and
are solved independently.

Private-call adjacency is indexed once. Tarjan SCCs solve monotone bitmasks in
callee-first order for parameter effects and caller-first order for result
effects. Within an SCC, a delta queue reevaluates only callers or callees whose
dependency acquired a new bit. A cycle that cannot acquire a proven terminal
is seeded as escape.
The bounded cost is O(local role edges + private call edges × finite lattice
height); the implementation neither rescans every call for every function nor
clones state per call path. Counters expose eligible private functions,
parameter summaries, exact call edges, opaque identities, member evaluations,
and bit updates. A private identity with more than 64 distinct private callees
or more than 64 exact callers is initialized as opaque escape before its local
transfer graph is solved. This explicit constant keeps dense hubs bounded while
retaining the pre-phase conservative result. Generated chains, terminal-bearing
cyclic SCCs, and dense hubs of 250, 500, and 1,000 private functions or edges
hold semantic density constant and assert linear counter bounds.

Module constructs and compiler events are indexed once, before private
functions are visited. Deterministic counters separate accepted scaffolding,
metadata, typespec, declaration, literal-attribute, and sigil-attribute classes
from module rejections for `use`, hooks, generated code, custom calls, unsafe
declarations or attributes, unknown events, and ambiguous bundles. A
250/500/1,000-function series retains every function, call edge, typespec,
nested literal attribute, and built-in word-sigil attribute while asserting the
same linear solver bounds; source classification is O(bytes + constructs) and
event joining remains O(events). The real neutral private-flow fixture combines
`@moduledoc false`, one exact `@spec`, exact alias/import/require declarations,
nested literal data, and every accepted built-in word/string/date/time sigil.
It must materialize nonzero private summaries and preserve supported deletion
of its unrelated dead export.

This checkpoint intentionally does not infer public or cross-module summaries,
does not emit private functions as public claim subjects, and does not change
the JSON schema. Neutral real-compiler coverage proves a private producer and
consumer can end at a data sink without contaminating an unrelated high-
confidence deletion. Public returns and private invocation helpers retain the
existing escape or invocation hazards and deletion refusal.

### Phase 1B2A.3 same-module public parameter checkpoint

The next bounded slice extends parameter summaries, but not result summaries,
to exact same-module public `def` functions. Elixir private functions cannot be
called across modules, so this checkpoint first proves the public-definition
identity and safety boundary without adding cross-file resolution. A candidate
must be one direct top-level `def`, have one parenthesized list of distinct
variable parameters, and have exactly one reflected public-function record at
the same canonical module, file, source line, arity, partition, and compiler-
validated owner. Guards, defaults, patterns, multiple clauses, delegates,
macros, generated siblings, missing or duplicate reflection, and every module-
scope rejection from Phase 1B2A.2 remain opaque.

Only exact compiler `local` calls in the same module and partition may use a
public parameter summary. A parameter may terminate as data, invocation, or
escape, or propagate to the call result so the caller's already-indexed sink
decides the outcome. This is sound independently of unknown callers because it
describes the complete single-clause body for an input, not the disposition of
values created by the callee. A computed atom produced inside a public function
and returned from it therefore remains an escape. Result summaries remain
private-only, and no cross-module, dependency, sibling-boundary, or repository-
merge inference is added.

Private and public parameter nodes share the same pre-indexed call adjacency,
Tarjan components, monotone bitmasks, delta queues, and 64-caller/callee bound.
Counters distinguish exact public definitions, parameter slots, local call
edges, producer-flow matches, SCC member evaluations, bit updates, and opaque
public identities from private and standard-library/plugin summary counters. A
250/500/1,000-function public chain retains every definition and edge while
asserting linear counter bounds; a 65-callee hub proves the explicit bounded-
escape fallback. Neutral real-compiler fixtures prove direct data consumption,
caller-side pass-through consumption, invocation, public-origin return escape,
multiple-clause ambiguity, accurate explanation, deletion refusal for active
uncertainty, and supported deletion of an unrelated high-confidence export.

### Phase 1B2B exact cross-module public parameter checkpoint

Phase 1B2B extends only public parameter summaries across module files inside
one complete compiler TraceResult for one Mix frontend boundary. Definition
bodies retain their file-qualified identity `(module, file, partition, name,
arity)`. A separate canonical target index removes the caller-file dimension:
`(module, partition, name, arity)` resolves only when exactly one eligible,
project-owned, reflected public definition remains, carrying its own exact
source file and line. A missing, duplicate, conflicting, or wrong-world target
does not produce an edge.

Each admitted edge requires one source call with exact cardinality and one
compiler `remote` or `imported` event. The event supplies the
canonical `to_mod`, name, and arity, so source aliases and imports never become
guessed identities. Caller and callee must share the production/test world,
the production compile and test partition must both be complete, and both
modules must belong to the current TraceResult. Dependency modules, sibling
Mix boundaries, incomplete traces, unsupported no-parenthesis calls, and every
source/module/reflection rejection from Phase 1B2A.3 remain escapes.

The new edges enter the existing indexed function-summary graph. Tarjan SCCs,
monotone parameter bitmasks, delta queues, and the 64-caller/callee bound are
unchanged; there is no producer-specific graph traversal. Public result
summaries are still never created or solved. A parameter-derived value may
return through an exact public callee for a caller-side sink to consume, while
an atom created inside any public callee and returned remains an escape.
Private result summaries remain same-boundary and private-only.

Dedicated counters expose canonical cross-module target identities, exact
edges, producer matches, identity rejections, boundary escapes, SCC member
evaluations, parameter-bit updates, and opaque participants. Generated
250/500/1,000-file chains retain one definition and edge per step; two-module
terminal-bearing and terminal-free cycles prove fixed-point outcomes; and a
65-callee multi-file hub proves bounded escape. Neutral real Mix fixtures cover
explicit remote and aliased calls, an imported call, caller-side pass-through,
a same-module wrapper, invocation, an unknown dependency sink, public-origin
return escape, rejected default arguments, accurate `why`, conservative
deletion refusal, and supported deletion of an unrelated high-confidence
export. No JSON schema, canonical stdout, dependency, sibling-boundary, or
repository-merge contract changes.

### Phase 1B2B.1 cross-module decision ledger checkpoint

This instrumentation-only checkpoint makes every Phase 1B2B cross-module
admission or rejection auditable without changing its semantic disposition.
The ledger deliberately keeps four universes separate: raw compiler call
records and exact-key groups; indexed source-call/world joins; canonical target
eligibility identities; and unique call-site decisions. Admitted call edges are
additionally partitioned between dependencies whose callers participate in the
summary graph and event-level edges from otherwise ineligible callers. Exact
sum invariants preserve the legacy canonical-rejection, boundary-escape, and
admitted-edge totals.

Each call decision has one disjoint first-outcome reason. Rejections distinguish
source cardinality, missing or ambiguous compiler joins, caller ownership and
eligibility, incomplete boundaries, external delegation, arity mismatch, and
each canonical target failure. A reason never borrows source shape from a
same-name function at another arity. `source-call-unindexed` means only that an owned compiler event
group had no supported indexed source call; it does not infer a specific source
syntax. Module-safety rejection flags form a separate overlapping record because
one unsafe target can contain more than one construct.

### Phase 1B2B.3 semantic-provider inventory checkpoint

Convention-owned atom-role summaries are now supplied through one generic,
validated pre-graph inventory rather than being wired directly into the Elixir
language plugin. A convention provider has a namespaced `convention:*` id, one
valid Hex dependency name, one or more exact audited semantic versions, and
one or more summaries whose origin exactly matches the owning plugin and
dependency. The inventory rejects malformed or duplicate providers, invalid
versions and roles, ownership mismatches, and canonical callee collisions with
either the language registry or another provider before any project boundary
is analyzed. Registry defects therefore fail loudly; environmental
non-applicability remains a conservative omission.

The repository dispatcher constructs this immutable inventory once from the
same deterministic built-in convention registry used after graph construction.
It passes the exact inventory to root-only Elixir analysis and through the
shared repository context to nested and mixed-boundary analysis. Provider
availability is consequently independent of repository topology and of a
convention's later graph-phase `applies` result. Neutral real-compiler coverage
locks this parity across root, nested, and mixed TypeScript/Elixir layouts. The
same coverage schema-validates the one-line canonical JSON projection, proves
supported deletion with an applicable provider, and proves `why` evidence plus
deletion refusal when an unaudited version conservatively restores the escape.

Runtime applicability remains deliberately narrower than registration. The
Elixir frontend builds one dependency set from compiler facts, parses
`mix.lock` once into exact Hex versions, and activates only providers whose
declared dependency is present at an audited version. Missing or malformed
locks, path/git dependencies, unaudited versions, and absent dependencies omit
the provider and retain the existing escape hazard. Project-owned modules
continue to defeat dependency-summary matching, so a project cannot spoof a
reviewed dependency callee. Sparse summaries also remain fail closed: omitted
argument roles escape rather than acquiring optimistic semantics.

This checkpoint changes no report or JSON schema, claim rule, hazard effect,
or deletion-plan rule. A provider can only classify value-flow roles; it cannot
emit or suppress claims. Applicability costs O(lock bytes + dependencies +
providers + summaries), with one lock parse per Elixir boundary and no
per-provider filesystem read.

Escaping computed-atom producers receive diagnostic attribution without
retaining per-producer decision sets. A finite reason bitmask is propagated
beside the existing semantic bitmask through the same value graph, public and
private parameter summaries, private result summaries, SCC delta queues, and
call adjacency. Zero reasons is `unattributed`, one reason names that decision,
and more than one is `multiple`; overlap counters preserve the constituent
reasons. The reason vocabulary is guarded below 31 bits. It never participates
in data, invocation, escape, hazard, claim, explanation, or deletion decisions,
and it adds no graph walk.

The generated 250/500/1,000-file cross-module chain retains every source,
definition, event, decision, target, and edge at fixed density while asserting
exact linear ledger counts. A neutral real-compiler fixture exercises a
controller-shaped `use` rejection, attributes the producer escape to module
safety, and proves the same live claims, unrelated dead control, hazard site,
and conservative deletion refusal. Canonical JSON and the public schema remain
unchanged.

A parallel 250/500/1,000 series retains distinct `use`-bearing rejected targets
and producers at every size. Module/world ownership, any-world presence,
reflection identities, and source ranges are indexed at construction, so lazy
reason materialization does not scan the trace or source per rejected target.
A real caller-side fixture proves direct source calls in `use`-bearing and final
`defoverridable` implementations remain non-summary event edges. Calls emitted
only by `use`, including a generated private carrier, remain conservatively
unindexed and activate carrier-scoped escape/deletion refusal; no final
generated-clause provenance is claimed.

### Phase 1B2B.4 audited dependency constructor-result checkpoint

Phase 1B2B.4 adds two sparse constructor-result families to the pre-graph
semantic-provider inventory. They classify only computed-atom flow through
successful calls; they do not claim that every argument accepted by the public
API is an atom, and they do not turn storing a value into a `consume-data`
terminal.

The existing `convention:ecto` provider at exact Hex version `3.14.1` now owns
`Ecto.Changeset.add_error/3` roles `{0: propagate, 1: propagate}` and
`add_error/4` roles `{0: propagate, 1: propagate, 3: propagate}`. The successful
clause retains the incoming changeset and prepends `{key, {message, keys}}` to
the returned errors. The binary-guarded message position is deliberately
omitted: a direct computed atom there cannot reach a successful result.
Non-changesets and non-binary messages raise `FunctionClauseError`. The path
has no callback, protocol, `apply`, or dynamic-MFA behavior.

A new provider-only `convention:money` plugin owns only `Money.new/2` role
`{1: propagate}` for Hex package `money`. On success the integer-guarded amount
is stored as `amount`; the currency passes through `Money.Currency.to_atom/1`,
is validated, and is stored in the returned `%Money{}`. Atom currency conversion
is identity, including configured custom currencies. The integer position is
omitted because an atom there cannot satisfy the guard. An invalid currency
raises `ArgumentError`; a non-integer amount raises `FunctionClauseError`. This
path likewise has no callback or dynamic invocation.

The exact Money release inventory is:

`1.0.0-beta`, `1.0.0`, `1.1.0`, `1.1.1`, `1.1.2`, `1.1.3`, `1.2.0`,
`1.2.1`, `1.3.0`, `1.3.1`, `1.3.2`, `1.4.0`, `1.5.0`, `1.5.1`, `1.6.0`,
`1.6.1`, `1.7.0`, `1.8.0`, `1.9.0`, `1.10.0`, `1.11.0`, `1.12.0`,
`1.12.1`, `1.12.2`, `1.12.3`, `1.12.4`, `1.13.0`, `1.13.1`, `1.14.0`,
and `1.15.0`.

Every listed release was semantically audited from its exact published Hex
archive. `0.0.1-dev` is excluded because its overload and validation surface is
materially different; future versions remain excluded until separately
audited. The current `1.15.0` archive is byte-identical to upstream tag
`v1.15.0` for `lib/money.ex` (SHA-256
`572da818b1b7a07aa51589ab0682bf20653dd634bd9bef05b40a63a25df61aac`) and
`lib/money/currency.ex` (SHA-256
`c6b5874cff82cd143a235ec6eb237fef80e78689dac0fc1f1dec0cb40f80b143`).
The Hex package checksum is
`25a0400bd518a0dab4166563f3bd8625376b69da23563070b67fadf363663533`.

Ecto `3.14.1` `lib/ecto/changeset.ex` is byte-identical between its Hex archive
and upstream tag `v3.14.1` at SHA-256
`46d8e3e7445ead10cf33811e22af773edfafa80e0e992e91bc48777b0649500d`;
the Hex package checksum is
`24b991956796700f467d0a3ef3d303138a3ef9ddddf8b98f43758ee067b20a30`.
Primary evidence is the [Money release inventory](https://hex.pm/api/packages/money),
[`Money.new/2` documentation](https://hexdocs.pm/money/1.15.0/Money.html#new/2),
[tagged Money constructor](https://github.com/elixirmoney/money/blob/v1.15.0/lib/money.ex#L62-L83),
[tagged currency conversion](https://github.com/elixirmoney/money/blob/v1.15.0/lib/money/currency.ex#L295-L336),
[Ecto release inventory](https://hex.pm/api/packages/ecto),
[`add_error/4` documentation](https://hexdocs.pm/ecto/3.14.1/Ecto.Changeset.html#add_error/4),
and the [tagged Ecto implementation](https://github.com/elixir-ecto/ecto/blob/v3.14.1/lib/ecto/changeset.ex).

Both providers inherit the Phase 1B2B.3 fail-closed contract: exact compiler
dependency identity plus one structurally valid Hex lock entry at an audited
version, unique source and compiler-event cardinality, and no project-owned
module spoof. Missing, malformed, path/git, package-mismatched, development,
future, or otherwise unaudited lock evidence omits the summary silently.

Neutral real-Mix fixtures prove compiler-confirmed static result propagation to
a later data terminal, result escape through an opaque downstream call, exact `why` evidence,
supported deletion of an isolated high-confidence control, and zero-stage
deletion refusal under the propagated escape. The Elixir corpus invokes the
production registry-driven analyzer so provider behavior is corpus-locked;
switching from the low-level direct frontend changes no pre-existing case.
Generated 250/500/1,000/2,000-site series retain three role-summary matches per
producer with bounded role-edge and queue work. No graph pass, public JSON
schema, claim rule, or deletion rule changes.

### Phase 1B2B.2 local-cause and caller-eligibility checkpoint

This instrumentation-only checkpoint adds two diagnostic masks that are
separate from both semantic outcomes and the Phase 1B2B.1 cross-call decision
mask. The 22-bit local escape-cause mask distinguishes assignment,
container/return, call/event/summary, callback/role, private-result, SCC, bound,
and defensive root fallbacks. The 11-bit caller-eligibility mask distinguishes
supported source-shape, direct ownership, module safety, and reflection
failures. Each vocabulary is independently guarded below 31 signed bits.

Both masks propagate only through the existing value-node queue, parameter
summary arrays, private-result arrays, and SCC delta queues. They cannot change
data, invocation, escape, hazard, claim, explanation, deletion, or canonical
JSON behavior. Joined escaping producers have exactly one local primary bucket
(`multiple` for overlap and `unattributed` only for a defensive zero mask).
Every joined producer, regardless of disposition, has exactly one caller-
exposure primary bucket. Caller-ineligible decisions have their own exact
primary sum and overlapping causes/module-safety flags. Unjoined producer
fallbacks remain outside the value graph and are partitioned separately among
missing source, ambiguous source, and ambiguous producer event.

No-parentheses definitions remain a deliberate attribution limit. Their source
range does not supply the arity required by the existing source/compiler join,
so the compiler event remains `source-call-unindexed`; Phase 1B2B.2 does not add
a reverse lookup or guess a caller syntax. Likewise, structurally unreachable
defensive graph fallbacks retain explicit zero-count controls rather than
synthetic executable fixtures. These limits preserve the frozen bounded model
and do not weaken the existing conservative escape/deletion behavior.

Neutral fixtures cover each executable local branch, caller source and
reflection rejection, nested ownership, real `use`/`defoverridable`/generated
caller safety, no-caller and unsafe-caller private results, parameter and
private-result SCC cycles, the 64-degree bound, and all three unjoined causes.
The fixed-density 250/500/1,000/2,000 producer series asserts exact cause
density plus constant-multiple role-edge and queue-visit bounds. Canonical
stdout, public JSON, schemas, hazards, claims, and deletion planning remain
unchanged.

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
