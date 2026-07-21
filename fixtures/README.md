# Fixture corpus

This is the golden-fixture corpus described in `docs/adr/0009-test-strategy.md`
and `docs/architecture.md` §1/§4. It is the enforcement mechanism for the
top quality metric in `CLAUDE.md`: **false-positive rate**. A false-positive
regression against this corpus blocks merge, no exceptions.

The fixture harness loads this hand-labelled ground truth, runs the applicable
TypeScript, Elixir, Rust, or polyglot analyzer, and scores precision/recall by
confidence tier. Committed scoreboards and non-vacuous corpus gates make these
cases release evidence rather than illustrative samples.

## Layout

```
fixtures/<language>/<case>/
  package.json     # minimal, own manifest — not a workspace member
  tsconfig.json     # minimal, self-contained
  src/               # the fixture's source files
  labels.yaml        # ground truth for every labelled subject
```

Polyglot cases use `fixtures/polyglot/<case>/` with one manifest/source tree per
language. Copy `fixtures/templates/convention-plugin/` for a neutral starting
shape; templates are not corpus cases and are never scored.

Each case is a **minimal mini-repo** exercising **one mechanism**. Cases are
never deleted, only added or corrected via reviewed label changes (ADR 0009).

## `labels.yaml` format

```yaml
case: <kebab-name>
description: <one line>
subjects:
  - kind: export | file | dependency | test
    name: <symbol name, or repo-relative path for a file/test, or package name for dependency>
    file: <repo-relative file the subject lives in>   # for dependency: package.json
    expected: dead | alive | test-only
    minConfidence: high | medium | low   # ONLY when expected is NOT alive (dead or test-only)
    because: <why this label is true — one sentence>
```

- `kind` — what's being judged: an `export` (a named symbol), a `file`
  (whole-file liveness, e.g. a dead file or an ambient `.d.ts`), a
  `dependency` (an npm package), or a `test` (a whole test file flagged
  as a zombie — the M5 tier-2 subject; see `expected: test-only` below).
- `name` — the export's symbol name; the repo-relative path for a `file`
  or `test` subject; the package name for a `dependency` subject.
- `file` — the repo-relative file the subject lives in (for a `file` or
  `test` subject this is the same path as `name`; for a `dependency`
  subject this is `package.json`).
- `expected` — `alive`, `dead`, or `test-only`. **Alive labels are not
  decoration** — they are the primary defence against false positives,
  which is the product's top quality metric. A case that only ever labels
  dead code can never catch an analyzer that is dead-happy.
  - `dead` expects an **`unused`** claim (reachable from nothing).
  - `test-only` expects a **`test-only`** claim — the M5 tier-2 verdict
    (T5.2): code, a dependency, or a whole test file reachable only from
    test entrypoints, deletable together with its test. The verdict must
    **match**: an `unused` claim on a `test-only` subject is scored a
    false positive (it tells you to delete code a test still imports — the
    exact hazard tier 2 exists to catch), and vice versa.
- `because` — mandatory on every subject. Explains *why* the label is
  true in one sentence, so a human reviewing a label (or a disagreement)
  doesn't have to re-derive the reasoning from the source.

### The `minConfidence` rule

`minConfidence` is present on every **non-`alive`** subject (`dead` or
`test-only`) and absent on `alive` subjects. It means two different things
depending on whether a dynamic-reference hazard (architecture §4) is in
play for that subject:

- **Hazard subjects** (e.g. a string/computed-import target, a
  `require(expr)` target, a config-referenced file): `minConfidence` is a
  **ceiling**. If the analyzer flags the subject dead at all, its
  confidence must be **at most** this tier — e.g. `medium` means "high
  confidence is a bug here; medium or low is acceptable." This encodes
  the PRD §4 confidence contract: a modelled hazard forces a downgrade
  from `high`.
- **Clean subjects** (no hazard nearby): `minConfidence` is `high`, and
  it means the analyzer's confidence **must be exactly** `high`. A clean,
  unambiguous dead export that only gets scored `medium` or `low` is a
  recall bug worth flagging, even though it isn't a false positive — the
  corpus expects the analyzer to be as confident as the evidence allows.

> **M1 harness note (reviewer-reconciled):** the harness currently treats
> every `minConfidence` as a ceiling only — under-confidence on clean
> subjects is intentionally NOT surfaced or gated in M1 (it is a recall
> concern, never a false-positive risk). Surfacing clean-subject
> under-confidence is deferred to the M3 confidence-assignment work.

In both readings, a confidence **higher** than `minConfidence` on a dead
claim is a hard failure (a false-positive-adjacent overclaim); the
difference is only in whether an *under*-confident claim is tolerated
(hazard subjects: yes, that's the point) or flagged (clean subjects: no).

`expected: alive` subjects never carry `minConfidence` — there is no
confidence tier for a claim that must not be emitted at all. If the
analyzer emits any `dead` verdict for an `alive`-labelled subject, at
any confidence, that is a false positive, full stop.

## Adding a case

1. Pick **one mechanism** to test (one hazard class, one IR edge type, or
   one inverse/FP-trap scenario). Do not combine mechanisms in a single
   case — it makes failures ambiguous to diagnose.
2. Create `fixtures/<language>/<case-kebab-name>/` with its own minimal
   `package.json` and `tsconfig.json` (or the language's equivalent),
   plus a `src/` tree. Keep it as small as the mechanism allows.
3. Write `labels.yaml`. Label every subject that matters to the
   mechanism, dead or alive, each with a `because:`. Prefer including at
   least one `alive` subject per case — it is what catches the analyzer
   being wrong in the dangerous direction.
4. Verify the fixture is syntactically valid for its language (e.g. it
   parses/typechecks with a standard toolchain) even though it is
   deliberately weird in shape.
5. If a case is informed by a publicly documented Knip/Fallow issue or
   test (see below), note the mechanism in the case's `description`, not
   the incumbent's name or wording — the case itself must be re-derived,
   not copied.

## Never edit a label to make a test pass

Labels are ground truth (ADR 0009). If the harness disagrees with a
label and the label looks right, the analyzer has a bug — fix the
analyzer. If a label looks wrong, **do not edit it to make a run go
green**: escalate it to the orchestrator with the reasoning for why it
looks wrong. A label change is a reviewed decision, not a side effect of
a failing run.

## Incumbent-study policy

Per `CLAUDE.md` ("study the incumbents, never copy them"), fixture
scenarios may be **informed by** publicly documented false-positive
classes from Knip (ISC) and Fallow (MIT) — their test suites and issue
trackers are useful for enumerating hazard scenarios we might otherwise
miss. Every case here is **re-derived from scratch**: no fixture or
source file is copied from either project. If anything is ever directly
adapted rather than re-derived, the upstream license attribution must be
carried alongside it. Milestone smoke-triage tasks separately run a
differential comparison against Knip on real repos (`docs/phasing.md`,
M3 onward) — that is a different mechanism from this corpus and does not
license copying fixtures either.

## Why fixtures live outside `packages/`

`fixtures/` is intentionally **not** a pnpm workspace member (the
workspace glob in `pnpm-workspace.yaml` is `packages/*` only) and is
excluded from the root `typecheck`, `boundaries`, and `lint` scopes — see
the root `CLAUDE.md`/architecture notes on tooling scope. Each fixture's
own `package.json`/`tsconfig.json` exists so a future harness (or a
human) can point a real toolchain at the mini-repo in isolation; it does
not participate in this repo's own build.
