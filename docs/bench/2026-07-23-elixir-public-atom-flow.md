# Elixir same-module public atom-flow checkpoint

Date: 2026-07-23
ADR: 0014 Phase 1B2A.3
Scope: exact same-module public parameter summaries only

## Delivered boundary

- One direct top-level public `def` with parenthesized, distinct variable-only
  parameters may contribute a parameter summary.
- Source, reflected function, compiler owner, module, file, line, arity, and
  production/test world must agree exactly.
- The complete Phase 1B2A.2 module-safety bundle remains mandatory.
- Only one exact same-module compiler `local` call may consume the summary.
- Data, invocation, escape, and propagation-to-caller-result roles are retained.
- A computed atom created in a public function and returned from it remains an
  escape. Result summaries remain private-only.
- Guards, defaults, patterns, multiple clauses, delegates, macros, generated
  siblings, missing or duplicate reflection, and ambiguous calls fail closed.
- No cross-module, dependency, sibling-boundary, or repository-merge summary is
  inferred.

## Complexity evidence

Private and public parameter summaries share one indexed call graph, Tarjan SCC
decomposition, monotone finite bitmasks, delta queues, and the established
64-caller/callee bound. Dedicated counters distinguish public definitions,
parameter slots, exact local call edges, producer-flow matches, SCC evaluations,
bit updates, and opaque public identities.

The generated public-chain series retains the following exact semantic density:

| Public chain length | Eligible definitions | Parameter slots | Call edges | Producer matches |
| ---: | ---: | ---: | ---: | ---: |
| 250 | 251 | 252 | 250 | 1 |
| 500 | 501 | 502 | 500 | 1 |
| 1,000 | 1,001 | 1,002 | 1,000 | 1 |

Each size ends at one data sink with zero escapes. Counter assertions bound SCC
evaluations, bit updates, role edges, and queue visits linearly. A separate
65-callee hub becomes one explicit function-summary bounded escape rather than
truncating its call set.

## Real-compiler evidence

The neutral safe fixture materializes four exact public definitions, seven
parameter slots, two local call edges, and two producer-flow matches. Its direct
and pass-through flows both end at data sinks; the unrelated dead export remains
high-confidence and deletion-supported.

The neutral unsafe fixture materializes five exact public definitions, five
parameter slots, two local call edges, and one producer-flow match. It retains
one invocation and two escapes for dynamic invocation, a public-origin returned
atom, and an ambiguous multiple-clause helper. Explanation identifies the real
hazard sites and deletion remains unsupported while those hazards are active.

## Verification transcript

- Independent frozen-diff review: SHIP, with no blocker, high, or medium
  findings. Both low coverage/wording observations were addressed before the
  final gates.
- Focused runtime-reference and emitter tests: 93 passed.
- Full suite: 93 files and 1,411 tests passed.
- Dependency boundaries: 937 modules and 2,133 dependencies, with no
  violations.
- TypeScript corpus: 52 cases, 237 subjects, precision 1.0, recall 0.827.
- Elixir corpus: 29 cases, 93 subjects, precision 1.0, recall 0.974. Both new
  cases have precision and recall 1.0.
- Rust corpus: 4 cases, precision 1.0, recall 0.833.
- Polyglot corpus: 1 case, precision and recall 1.0.
- Build, 10 packaging tests, and an `npm pack --dry-run` containing 351 entries
  passed. The generated assumption document is synchronized.
- The scoped privacy scan found no consumer name, local absolute path, or
  private-run measurement.

## Resumption point

Phase 1B2A.3 is deliberately complete before Phase 1B2B. The next semantic
increment, if independently justified, is exact project-owned public parameter
flow across modules inside one validated Mix frontend boundary. It requires a
canonical callee identity index independent of the caller file. Public-origin
result summaries and cross-boundary closure remain out of scope until application
ownership and external-caller semantics are explicitly represented.

Before any next increment, preserve the focused unit, real-compiler, corpus,
deletion, scaling, assumption-sync, packaging, and privacy gates recorded by
this checkpoint.
