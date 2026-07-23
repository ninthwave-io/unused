# 0011 — Elixir frontend: compiler-tracer-based reference graph

Date: 2026-07-19
Status: Accepted (founder delegation, 2026-07-19; pre-v0.1.0 multi-language foundations directive)

## Context
ADR 0003 committed to multi-language positioning with per-language frontends emitting the shared IR, and named Elixir next-after-Python — moved ahead by founder directive (2026-07-19): the multi-language skeleton/pattern must exist before v0.1.0, proven against a real Elixir codebase. Research (docs/research/elixir-landscape-2026-07.md, verified live on Elixir 1.20.2/OTP 29): `mix xref` is module/file-level only since v1.10 and cannot answer function-level liveness; the compiler tracer API (`Code.put_compiler_option(:tracers, ...)`) delivers function-level events (`remote_function`, `local_function`, `struct_expansion`, …) and is what `mix_unused` and `boundary` build on; no maintained liveness competitor exists in the ecosystem.

## Options considered
- **Source parsing** (tree-sitter/custom AST) — reimplements macro and protocol expansion the compiler gives away free; the same anti-pattern ADR 0005 rejected for TS/JS. Rejected.
- **`mix xref`-based** — near-free machine-readable module graph, but module-level only: structurally cannot claim an unused function. Rejected as primary; kept as a cross-check.
- **Compiler-tracer-based** — function-level reference events from the real compiler (macros/protocols already expanded); requires running `mix compile` in the target project (a build, not a read) — a real departure from the TS frontend's no-execution posture that must be stated honestly.

## Decision
The Elixir frontend obtains its reference graph from a **custom compiler tracer** injected via a generated tracer module and `mix compile --force`, supplemented by `mix xref graph --format json` as a module-level consistency cross-check. Events map to the existing IR (nodes: modules/functions as symbols, files, apps as packages; edges with spans from tracer metadata). Entrypoint model: OTP application callbacks + supervision-tree children, Phoenix endpoint/router, mix tasks, releases config — production roots; `test/` + ExUnit = test partition; `config/*.exs` = config roots. Umbrella apps map to the existing workspace-unit model.

**Honest posture difference, stated in the assumption set**: analyzing Elixir runs the project's own compiler (and therefore its compile-time code) in a child `mix` process — unlike the TS frontend, which never executes user code. This is disclosed, not hidden; a user who cannot compile (or trusts nothing) gets a refusal, never a silently-wrong answer. No network, no telemetry, unchanged.

**Hazard classes (Elixir registry entries from day one)**: behaviour/OTP callback dispatch (callbacks are reflectively invoked — implementations of a used behaviour are alive); dynamic dispatch (`apply/3`, `Module.concat`, config/`runtime.exs`-resolved modules — verified invisible to tracing; scope-capped, never confidently dead); Phoenix/protocol runtime dispatch (LiveView callbacks, `defimpl` blocks; HEEx template visibility to tracing is UNVERIFIED — flagged for empirical testing in the skeleton phase, treated as a project-scope hazard until proven).

Evidence that would reverse this: the tracer approach failing to produce a usable function-level graph on a real Phoenix codebase (the reference-codebase assessment is the test), or the compile-requirement proving unacceptable to users — fallback would be xref-based module-level claims only (a smaller, honest product).

## Consequences
- v0.1.0 ships the Elixir frontend as a **skeleton behind the frontend interface**: tracer + IR emission + entrypoint model + hazard registry entries + a small labelled corpus (`fixtures/elixir/`), marked experimental; full parity (config, presets-equivalent, dependency claims via mix.lock) is post-v1 roadmap.
- The frontend interface gets its second real implementation, proving ADR 0003's core constraint before the first release — the point of the founder directive.
- Requires Elixir/OTP present to analyze Elixir projects (refusal with a clear message otherwise).
- The corpus gains a `fixtures/elixir/` tree with the same labels.yaml contract (per-language layout existed from M1 by design).

## Implementation amendment — isolated build state (2026-07-21)

The compiler tracer runs the analyzed application under a temporary
`MIX_BUILD_PATH`. It reuses previously compiled dependency application paths but
does not place the analyzed application's compiler manifests, BEAM files, `.app`
resource, or consolidated protocols in the project's `_build`. This preserves
the compiler-backed precision decision while preventing analysis from making a
subsequent `mix compile --warnings-as-errors` regenerate consolidation output.
A project whose dependency artifacts are not available from a prior clean
compile is refused explicitly; the analyzer neither fetches nor silently builds
dependencies into the consumer's tree.

The isolated application layout also contains a link to the project's tracked
`priv` directory before `compile.elixir` begins. This preserves conventional
compile-time reads through `Application.app_dir/2` while keeping the resource
and the consumer's `_build` unchanged; the link exists only for the lifetime of
the analyzer's temporary directory.

## Implementation amendment — test-partition completeness (2026-07-21)

The production compiler trace and the separately compiled ExUnit partition have
independent completeness. A test module may execute module-body code that reads
application runtime state; normal `mix test` starts the application first, while
the analyzer deliberately uses `--no-start`. If that separate test compile
fails, production facts remain usable but the boundary is `partial` and its test
partition is `incomplete` in schema 1.4.0.

The analyzer does not start the application speculatively. Instead, a
non-claimable safety root keeps every compiler-known production file, module,
and public function alive, including exact cross-language bridge descendants.
Potentially test-reachable subjects therefore produce neither claims nor
supported deletion plans. One deterministic diagnostic is emitted on stderr;
canonical JSON stdout contains only structured completeness metadata.

## Implementation amendment — separate Mix test environment (2026-07-21)

Production and test facts are traced by separate child invocations. Production
keeps the caller's original Mix environment and strict refusal contract. The
test partition runs under explicit `MIX_ENV=test`, `--no-start`, and a distinct
temporary build whose dependency links come only from the consumer's matching
test-environment build. Neither child writes to the consumer build, and the
test child never starts the analyzed application, runs `mix test`, or requires
`test/test_helper.exs`.

Dependency artifacts are derived from each cached `Mix.Dep` rather than an
assumed `_build/<env>/lib/<app>` layout. The runner preserves Mix's
`MIX_BUILD_ROOT`, exact `MIX_BUILD_PATH`, `MIX_TARGET`, and
`build_per_environment` semantics, follows each dependency's actual build path,
and validates its default or custom `.app` resource unless `app: false`.
Absent optional dependencies and `compile: false, app: false` data dependencies
do not make an otherwise complete partition partial.

The test child compiles the effective test environment, but retains facts only
from the non-production `elixirc_paths` delta (conventionally `test/support`)
and deterministically sorted ExUnit source files. Compatible re-emission from
production-inventory files is ignored when the event is an exact production
duplicate, so production facts remain solely those observed in the original
environment. A semantically compatible production module may also emit an
additive edge only under `MIX_ENV=test`; that edge is retained as test-scoped
after strict source ownership validation. Novel/conflicting module or function
identity, or unprovable file ownership, is incomplete rather than merged
speculatively.

Each child writes a phase-delimited structured trace. Test facts are merged only
after an exit-zero child produces exactly one complete terminal record; partial
or malformed output is discarded. Missing same-environment dependency
artifacts, layout failures, timeouts, support/test compilation failures,
runtime exits, and module/file ownership collisions all produce the existing
explicit partial boundary, sanitized diagnostic, and production-surface safety
roots. They never abort already-complete production analysis or masquerade as a
complete test partition.

## Implementation amendment — load-free BEAM reflection (2026-07-22)

After compilation, both phases enumerate sorted BEAM paths in the isolated
application compile directory. Reflection reads the module identity, compile
source, attributes, and exports through `:beam_lib`, and reads EEP-48
documentation by file path for optional line evidence. It does not call
`Code.ensure_loaded`, `module_info`, `__info__`, or `function_exported?` on a
project module. A compiled module whose native `@on_load` hook cannot run in the
isolated application can therefore still be analyzed without executing that
hook.

The persisted attribute shapes provide behaviour, protocol, and implementation
markers. The export surface excludes VM/Elixir reflection helpers and raw
`MACRO-*` implementation exports. Missing documentation is valid and yields
line zero; a missing or malformed module identity, compile source, attributes,
exports, behaviour shape, or BEAM container remains a production refusal or a
bounded incomplete test partition. Test files use `compile_to_path` so their
BEAM metadata is available inside the same temporary, non-consumer build.

## Implementation amendment — default-argument wrapper reachability (2026-07-23)

Elixir compiles a declaration with default arguments into one maximum-arity
body plus public lower-arity wrapper exports. A call to a wrapper therefore
executes the declared body even though the compiler trace contains no source
call edge between those generated functions. Reflection now reads the EEP-48
function entry's validated `defaults` count and carries a required nullable
declared-target arity on every internal function record. When the documentation
chunk is deliberately disabled, the Elixir debug-info definition table is the
fallback authority; it is read only on that path. If neither authority can
disambiguate a repeated-name export surface, or if a target is absent,
cross-file, cross-partition, on a different source line, itself a wrapper, or
part of a non-contiguous wrapper range, production refuses and tests become the
existing bounded incomplete partition.

IR emission adds one exact static edge from each wrapper to the maximum-arity
body in the same module, file, and partition. Test wrapper edges are test-scoped.
The relation is intentionally one-way: reaching `function/1` generated from a
`function/2` declaration keeps `function/2` alive, but a direct `function/2`
call does not root the unused `function/1` wrapper. The compiler record scan,
validation, and edge emission are each linear in reflected functions. This is
an internal lockstep trace-record extension; canonical JSON and its public
schema are unchanged, and the structural source protocol remains version 2.

## Implementation amendment — test-scoped production edges (2026-07-22)

Compiler expansion can legitimately make a production-owned module emit an
additional reference only in the test environment. The merge accepts such an
edge only when the test compile re-emitted that module with exactly compatible
reflected semantics. An exact production event is still discarded. A novel
event must name its reflected owner and either carry the owner's exact validated
reflected source or a single safe extensionless compiler pseudo-source; the latter is
normalized to the unique reflected owner. Ownerless events are accepted only
from the explicit test inventory. Unknown owners, arbitrary allowed-file
substitution, paths, extension-bearing labels, and every ownership conflict
fail the complete test partition closed.

One content-free compiler-origin exception applies to exact production
duplicates. A library macro or tracked template can attribute the same event in
both phases to a safe repository-relative or unsafe external source other than
its reflected owner. After validating `from_mod` against that owner, production
validation records the event's exact semantic key and raw source only when the
raw source differs from the owner; safe repository-relative evidence remains
unchanged, while unsafe evidence is normalized to the owner in the public
trace. A test event is discarded only when both its semantic compatibility key
and raw source exactly match that bounded non-owner provenance. The provenance
is internal, weakly held, lazily allocated, and never serialized; changed
semantics, mismatched sources, ownerless/unknown events, and spoofs still fail
closed. Ordinary owner-sourced events allocate no provenance record and cannot
authorize a non-owner duplicate.

The shared IR marks the accepted edge as test-scoped. Production and config
reachability traverse shared edges only. The effective test world starts from
the same immutable production, config, and test roots with their original ids,
kinds, and reasons, then traverses shared plus test-scoped edges. Test-only
classification subtracts the production and config results from that effective
world; evidence therefore says the subject exists only in the test environment
while preserving the real root provenance. Per-test zombie analysis and
deletion-consequence checks use the same edge-activity rules. Ordinary shared
edges and incomplete-partition safety behavior are unchanged.

## Implementation amendment — standalone script inventory (2026-07-22)

The compiler trace is no longer the complete Elixir source inventory. The
shared repository discovery pass records every visible `.ex` and `.exs` path
under the same nested `.gitignore` policy used by the other frontends. Mix-
compiled sources, `mix.exs`, `config/**`, and `test/**` keep their existing
owners. Every other visible, untraced `.exs` becomes an ordinary graph file and
is claimable when unreachable; ignored and repository-external paths never
enter this path.

A compiled-in `convention:elixir-scripts` plugin contributes bounded static
facts before global reachability. Literal aliases, remote calls, MFA tuples,
exact `Code.require_file`/`Code.eval_file` loads, and script-defined module
names produce provenance-bearing edges to known project targets. An unreachable
script does not make its target live, but its inbound edge prevents a target-
only deletion plan from being advertised as safe. Calls into a module defined
by another untraced script conservatively retain the module surface as one
symbol; function-level script parsing remains outside the compiler-tracer
contract.

Only exact public conventions root a standalone script: an executable bit, an
Elixir/Mix shebang, `Mix.install`, an exact GitHub Actions/Taskfile command whose
executable position names that script (`elixir` or `mix run`), `.formatter.exs`,
`.iex.exs`, or an Ecto/Phoenix-owned `priv/**/migrations/*.exs` or
`priv/**/seeds*.exs` path when the matching dependency is present. Ecto's
documented migrator loads versioned scripts from each Repo's configurable
`priv` migration directory; Phoenix generates and documents its Repo seeds as
`mix run` inputs. Phoenix release generation emits compiled `.ex` plus shell
overlays, so it needs no broader `.exs` root. These rules root only the named
file. Arbitrary script directories, arbitrary `priv` scripts, and unreferenced
`.exs` files are never blanket-rooted.

Script-defined module surfaces and opaque dynamic invocation cannot support a
high-confidence file claim from this bounded extractor. They activate the
file-scoped `elixir-script-opaque` hazard and cap only that script at medium;
they neither suppress unrelated claims nor root the whole project. The
extractor masks non-code text using UTF-16 code-unit offsets and handles grouped
aliases, optional-parentheses calls/loads, captures, and MFA values. Residual
rooted-script syntax receives a carrier-reachable affected-symbol cap (or an
owning-unit cap only when the target is wholly opaque). Extraction is O(total
script bytes + resolved literal references × log(lines))
and reads each visible script once. Neutral measurements and reproduction are
recorded in `docs/bench/2026-07-22-elixir-script-inventory.md`.

## Implementation amendment — source roles for dynamic events (2026-07-22)

The compiler marks invocation primitives but does not describe how their values
are consumed. The frontend therefore indexes each compiler-owned source once
with a preserve-length lexical mask and delimiter/line tables, then joins source
facts to compiler events by file, line, carrier module/function, primitive, and
arity. Comments, strings, charlists, heredocs, and sigils retain offsets and
newlines but contribute no facts. A join is exact only at matching cardinality;
same-line or carrier ambiguity stays opaque. Dynamic-event projection into IR
uses the same full event identity rather than a file-and-line-only join.

A conventional guarded `__using__/1` that selects a helper through
`apply(__MODULE__, selector, [])` is exact only when every compiler-observed
`__using__/1` invocation is accounted for by one literal
`use Module, :helper` fact and each helper resolves to one reflected public
function. A missing, computed, duplicated, or ambiguous invocation retains the
dynamic-dispatch hazard. Exact helper edges preserve `why` provenance and leave
unselected siblings independently claimable and deletable.

Nested compiler-emitted `__using__/1` calls attributed to the same outer source
site do not invalidate that proof when exactly one dispatcher event matches the
literal outer module; alias fallback still requires a unique compiler alias
fact. A no-source generated `action/2` apply is bounded to owner-module arity-two
actions only when the same carrier/site/partition has one external
`Phoenix.Controller.__using__/1` witness, `phoenix` is a declared dependency,
and the project does not own `Phoenix.Controller`. A masked generic source
`apply` at the site, missing/duplicate witnesses, or custom lookalikes stay
opaque. A module-to-`action/2` convention edge activates the bounded hazard when
the owner module becomes reachable.

Ordinary `apply/3` extraction preserves each independently proven dimension:
the source module expression, function atom/name role, and, only for a closed
proper list of unambiguously separated arguments, arity. A computed argument
expression therefore does not erase a literal `__MODULE__` bound; the hazard
affects only reflected public functions on that owner module. A computed module
with a proven name and/or arity searches the corresponding cross-module indexed
candidate set; with no other proven dimension it remains boundary-wide. Parsed
inference also requires exactly one source `apply` token at the tracer site,
because the tracer can deduplicate same-line events; ambiguous source/tracer
cardinality and unparseable leading arguments remain opaque. Candidate sets are
directly indexed by module/name/arity dimensions, and the deletion planner
consumes the same affected-symbol scope as `why`, so an active local dispatcher
cannot refuse deletion of an unrelated module.

Function-scoped `String.to_atom/1` and `String.to_existing_atom/1` remain
dynamic proxies by default because an immediate atom receiver can emit no outer
compiler event. A non-hazard role is a complete direct key argument to a bounded
standard-library `Map` operation; the complete first field of a two-element
tuple returned as a complete `Enum.map/2` function clause whose result flows
immediately to `Enum.into(%{})`; or one exact local assignment from a
binary-guarded variable in a function-level rescued definition, when every
later same-function reference is the complete value of a map field inside an
indexed `Enum.map/2` call. A separate inline role accepts the complete third
(value) argument of literal `Map.put/3` with a literal atom key only when that
call is the complete payload of a sole `{:ok, payload}` try body. The matching
`try/rescue` must be directly inside one lexically matched `case`/`with` clause
whose binder pattern is either one exact local or one exact two-element
`{:ok, local}` success tuple. That same local must be positively and
conjunctively guarded by `is_binary/1`; it cannot be read or rebound before the
producer. Wrong-status, extra-element, nested, wildcard, aliasing, pinned, and
multiple-binder clause patterns remain opaque. Each
role requires unique matching compiler events on the same carrier. The inline
role additionally requires one producer in the try and unique guard and
`Map.put/3` events. Immediate receivers; apply, capture, MFA, dynamic Map
receivers/functions/keys, reassignment, binder mismatch, arbitrary or nested
tuples, unmatched rescue/clause scopes, intervening or otherwise unproven
pipelines, unknown consumers, and mixed same-line roles remain opaque.
Because interpolation bodies are executable while the literal masker hides
their text, any later `#{...}` in the function also invalidates the local
assignment proof, while interpolation in the inline try invalidates that role.
Non-interpolating literal/comment bodies remain inert. Function, delimiter,
block, clause-arrow, rescue, identifier, producer, call, and role indexes are
built once. ADR 0014 Phase 1B1 replaces per-producer suffix traversal with one
shared carrier/partition-local value-role graph and a finite bitmask delta
fixed point. Classification is O(source bytes + trace events + unique
role/def-use edges + emitted candidates); shared assignments and containers
are not rescanned per producer.

ADR 0014 Phase 1B1 supersedes the preceding closed list as the current
implementation contract. The legacy exact shapes remain compatibility
terminals, while a compiler-corroborated indexed local-flow engine now applies
sparse declarative standard-library summaries and Ecto summaries owned by the
registered built-in convention provider.
Unknown arguments, calls, returns, rebinds, interpolation, ambiguous
source/event cardinality, and unmodelled boundaries still fail closed. This
phase is intra-function only; it does not infer helper or module summaries.

### Internal structural trace protocol v2

The compiler child attempts one bounded read of every compiler-owned source
file and, when the file is readable and within cap, one
`Code.string_to_quoted/2` pass. This is an internal precision substrate and,
at introduction, a semantic no-op: no structural fact changes graph edges,
hazards, claims, evidence, or deletion plans until a separately reviewed phase
explicitly consumes it. The child emits no source, AST, literals, local
variable identifiers, or private-project prose. It emits only the
repository-relative owner path, a
SHA-256 digest and byte count, bounded visit counters, carrier identities,
grapheme-column spans, closed structural roles, and exact compiler-event joins.
The repository-relative path and module/function carrier identities cross the
child boundary and remain internal; this is source-minimized, not anonymous.

Every owned file has exactly one `complete` or explicitly `incomplete` bundle.
The hard per-file limits are 8 MiB, 500,000 AST visits, depth 256, 20,000
carriers, and 500,000 facts. Read, size, parse, ownership, and limit failures
emit zero digest/byte/counter fields and empty arrays; they never fabricate a
partial fact set. A `try` with `else` or `catch` is not modeled: encountering
one anywhere in a carrier rolls back every structural fact for that carrier,
not merely the unsupported control-result facts. Private helpers participate only when the compiler trace
proves a same-file carrier or call target; uncalled private definitions cannot
affect producer flow.

The first reviewed semantic consumers are deliberately closed and do not make
the structural bundle a general AST transport. `runtime-mfa` joins an exact
three-element tuple and its exact module-alias compiler event; the parent then
rereads the digest-validated span and accepts only a literal function atom,
adding references to every compiler-known arity of that named callback.
`use-dispatcher` joins the exact second argument of a dynamic `Kernel.apply/3`
or `:erlang.apply/3` inside the corresponding literal-selector `__using__/1`
carrier. It can discharge only that dispatcher's existing dynamic hazard, and
literal `use Module, :helper` sites must still be independently proven by the
existing source and compiler-event checks. Missing, ambiguous, incomplete, or
malformed evidence retains the prior conservative behavior. Neither role
transports a module name, function atom, selector variable, or source text
across the child boundary.

After the JSON parser materializes one bounded output record, the parent checks
declared array lengths before mapping them into normalized protocol arrays, then
revalidates path ownership, regular-file/realpath containment, content digest,
the complete owned-file inventory, reflected module/function ownership,
carrier identity, fact uniqueness, and fact containment in the carrier body.
Elixir columns are grapheme columns, so line grapheme bounds are indexed once
per file rather than rebuilt per span. A one-line definition uses the parser's
exact `end_of_expression` coordinate before falling back to its final AST child;
this keeps generated interpolation calls inside the carrier without guessing
an atom-name width. Neutral coverage fixes the contract for tab indentation, a
combining grapheme, and an emoji. Compiler events are indexed once for joins.
Phase-local wire event IDs never survive a production/test merge:
events are canonicalized by their immutable semantic key, facts are remapped,
and references are checked again. Duplicate compiler events coalesce, while
same-line calls at distinct columns and production/test ID collisions remain
distinct. An exact ordinary call-argument join requires the compiler coordinate
to equal the call target start. For an injected pipeline argument, the compiler
coordinate must be strictly after the whole-pipeline start, at or after the
left operand's end, and strictly before the whole-pipeline end.
A production phase requires exactly one matching production summary.
A test phase treats structural files plus exactly one matching test summary as
one optional all-or-nothing overlay: malformed, missing, duplicate, mismatched,
or invalidly joined structure drops only that overlay; already validated test
modules, functions, and events remain usable. Merge retains production and test
summaries under distinct partition-labelled fields rather than presenting the
production counters as an aggregate.

Extraction and validation are O(source bytes + AST visits + events + carriers +
facts). Semantic production/test comparison uses an in-order streaming digest
instead of sorting all facts or assembling a second whole-file JSON value. The
per-file byte, visit, depth, carrier, and fact fields are the accountable work
counters; extraction remains included in the existing Elixir parsing phase
wall/CPU/RSS measurement. JSON stdout is unaffected because this protocol is an
internal child-to-parent channel.
