# Spike — oxc-parser extraction feasibility (T1.5)

Date: 2026-07-18. Author: core-implementer (Opus). Milestone: M1 (phasing.md).
Purpose: ADR 0005's named reversal-evidence test — prove `oxc-parser`'s JS/NAPI
output supports the reference extraction the M2 TS/JS frontend needs, **before** the
stack commitment compounds. A false PASS is far worse than a FAIL.

- Environment: Node 22.16.0 (repo `.tool-versions`), `oxc-parser@0.140.0` (latest,
  published 2026-07-14), Apple M4 Pro / arm64.
- Runnable evidence: `spikes/oxc-extraction/` — one script per criterion, each with
  assertions encoding the expected outcome (a regression fails non-zero). Standalone
  package, deliberately outside the pnpm workspace (glob `packages/*`).

## What oxc-parser's JS API actually exposes

`parseSync(filename, source, { lang })` returns `{ program, module, comments, errors }`:

- **`program`** — full ESTree-ish AST including TS nodes (`TSTypeReference`,
  `TSTypeAnnotation`, `TSInterfaceHeritage`, `TSClassImplements`, `TSTypeQuery`,
  `Decorator`, …), every node carrying `start`/`end` spans.
- **`module`** — static ESM metadata: `staticImports` (each with `moduleRequest`
  and `entries[]` carrying `importName.kind` ∈ {`Name`,`Default`,`NamespaceObject`,
  `AllButDefault`,`None`}, `localName`, and a per-entry **`isType`** flag),
  `staticExports` (local exports, named re-exports, and `export *` with
  `importName.kind:"AllButDefault"`, each also carrying `isType`), `dynamicImports`
  (span only), `importMetas`, `hasModuleSyntax`.
- **`comments`** — flat list `{ type: "Line"|"Block", value, start, end }`, in source
  order. **Not attached to AST nodes.**
- **`errors`** — parse diagnostics (empty on all spike fixtures).

**Confirmed absent (as ADR 0005 and the research §1 stated): no scope tree, no symbol
table, no binding resolution over the NAPI boundary.** Everything semantic is ours to
build. This is the frame for every caveat below.

---

## Criterion 1 — value-position vs type-position references — **PASS**

Script `01-type-positions.mjs`. A ~40-line AST walk carrying an `inType` context flag
classifies every reference site, joined by name against `module.staticImports`.

Evidence (all assertions pass):

| construct | symbol | classified |
|---|---|---|
| `import type { W }` + `const w: W` | W | TYPE-ONLY (importType=true) |
| `import { W }` + `new W()` | W | VALUE |
| `import { W }` + `const w: W = new W()` | W | **BOTH** (type@ + value@ sites) |
| `const a: TA` (annotation) | TA | type-position |
| `interface I extends TB` | TB | type-position |
| `class K extends Sup` (`superClass`) | Sup | **value-position** (runtime value) |
| `class K implements Impl` | Impl | type-position |
| `const t: typeof Val` (`TSTypeQuery.exprName`) | Val | **value-position** (references the VALUE) |
| `import { type TB, vc }` (inline) | TB / vc | type / value |
| `export type { TA }` | TA | flagged via `staticExports[].isType` |

The two spec-critical subtleties both resolve correctly: `class extends X` references
the **value** `X` (it is `superClass`, evaluated at runtime), and `typeof X` inside a
type references the **value** `X`. The context-flip rule set that produces this is
small and explicit (§ script), and is the core of ADR 0005's two-sided type-reference
rule (architecture §4): type-position references are **real references**, resolved
statically, never blanket-downgraded.

**What oxc gives us:** `isType` per import/export entry; the AST nodes and spans to
locate every reference site. **What we build:** the context-flip walk (type/value
discrimination) and — critically — the name→binding resolution it is joined on.

---

## Criterion 2 — re-export traversal — **PASS**

Script `02-reexport-traversal.mjs`, fixtures `fixtures/reexport/` (`entry → barrel →
{a, a2, b}`). A ~30-line traversal over the per-file export records resolves through
the chain:

- **Star traversal:** `x` (imported from `barrel`) resolves through
  `export * from './a.js'` to its defining file `a.ts`. ✔
- **Named re-export:** `y` resolves through `export { y } from './b.js'` to `b.ts`. ✔
- **Non-re-export detected:** `b.ts` also exports `z` locally; `z` is **not**
  reachable through the barrel (empty result). ✔
- **Star ambiguity detected:** with `a.ts` **and** `a2.ts` both `export const x`, and
  the barrel star-importing both, `x` yields **two** candidate definitions — the
  collision is surfaced, not silently resolved. ✔

Export records distinguish the three cases cleanly: local export (`moduleRequest:null`,
`exportName.kind:"Name"`), star (`importName.kind:"AllButDefault"`,
`exportName.kind:"None"`), named re-export (`importName.kind:"Name"` + source). This is
exactly the `re-export` edge in architecture §3.

**What oxc gives us:** star sources, named re-export maps, local exports, all with
spans. **What we build:** the transitive traversal itself, and two things oxc does
**not** do: (a) `export *` gives only the *source*, never the *forwarded names* — the
full export surface of a barrel requires transitively parsing every star target;
(b) the star collision is *detectable* but *unresolved* — the frontend must pick the
liveness-safe policy (keep all candidates alive). Real module resolution here is
oxc-resolver's job (ADR 0005), stubbed in the spike with a `.js`→`.ts` swap.

---

## Criterion 3 — leading-comment capture — **PASS**

Script `03-leading-comments.mjs`. Deterministic association: for a declaration, the
nearest preceding comment whose `end` is before the declaration's **effective leading
edge** with only whitespace between.

- Simple: `/* unused:ignore legacy shim */` above `export const alpha` → reason
  captured. ✔
- **Decorator edge case:** `/* unused:ignore decorated case */` above `@Deco export
  class Beta`. oxc places the decorator span (start 30) **before** the
  `ExportNamedDeclaration.start` (36). Using `node.start` naively would see `@Deco` in
  the gap and **miss the suppression**. Computing the effective edge as
  `min(node.start, decorator starts)` fixes it → reason captured. ✔
- **Intervening-comment negative:** a suppression comment followed by *another* comment
  then the declaration → the suppression is correctly **not** applied (adjacency broken;
  nearest comment wins). ✔

**What oxc gives us:** comments with ranges. **What we build:** the association (a
positional index by span), the effective-leading-edge computation (**must** include
decorators — the concrete trap this spike caught), and the marker parse. Carried as
`suppression: { reason }` per architecture §4.

---

## Criterion 4 — throughput sanity — **PASS (informational)**

Script `04-throughput.mjs`. A ~284-line realistic TS module (imports, generics,
interfaces, classes with `extends`/`implements`, async methods) parsed 200× with a
**fresh string each iteration** (unique prepended comment — no string-identity cache),
after a 20-iteration warmup.

**~0.11 ms/file, ~9,200–9,400 files/sec** (parse only, single-threaded, M4 Pro; stable
across runs).

Order-of-magnitude reading: **parsing is not the bottleneck.** At ~5k modules (PRD §8)
parse alone is well under a second; the cold-run budget will be dominated by our own
extraction (AST walk + scope building), resolution, and graph work. The M2 bench
harness must time the **whole pipeline** — this number only says parse leaves ample
headroom, and should not be mistaken for an end-to-end figure.

---

## Caveats and risks for the M2 extractor

Enumerated honestly; each is work oxc does **not** do for us that architecture §3/§4
requires.

1. **[BIGGEST RISK] No scope/symbol/binding table over NAPI — we hand-roll name
   resolution.** The spike classifies by *name*; that is sufficient to prove the
   mechanism but not sufficient for correctness. M2 must build its own scope analysis
   to resolve *which binding* an identifier refers to and to handle **shadowing**: a
   local `const Widget`, a function parameter, a `catch` binding, or a TS **type
   parameter** `<T>` shadowing an imported `T`. Every mis-resolved binding is directly
   an FP or FN — this is the correctness-critical core deliverable ADR 0005 already
   flags ("we own every binding rule"), and it is the dominant M2 workload. Note the
   asymmetry vs Fallow, which consumes `oxc_semantic` (scopes+symbols) as a Rust crate;
   the NAPI JS path gets none of it. It *is* parity with Knip v6 (same NAPI path, own
   graph) — parity where parity is table stakes — but it is the hard part, and the
   single largest false-positive surface in the whole frontend.

2. **The type/value context-flip table must be completed and fixtured.** The spike
   implements the core flips (annotation, `extends`/`implements`, `typeof`→value,
   `superClass`→value, decorators→value, member/property-key skips). Not yet covered,
   and each a potential recall/precision bug: `TSQualifiedName` roots (`A.B` type refs),
   `TSImportType` (`import('./x').Y` — a module ref, not a local binding),
   `as`/`satisfies` (value expression vs type operand), `export =` / `import x =`
   (TS/CJS interop), `namespace`/`module` declarations, JSX identifiers, and
   value+type **declaration merging** (already a checker-only hazard in registry §4).
   The rule set is enumerable; M2 needs one fixture per flip.

3. **`import { X }` with `isType:false` used only in type positions is common.** The
   per-import `isType` flag is a shortcut only when *true*; a plain value import used
   solely as a type is decided by **use-site classification**, not the flag. Relying on
   the import flag alone under-reports type-only usage. (The spike combines both.)

4. **Barrel export surface is a graph property, not a file-local one.** `export *`
   exposes only the source; computing what a barrel actually exports requires
   transitively parsing all star targets. Combined with star collisions (criterion 2),
   the frontend must adopt a liveness-safe tie-break (keep every candidate alive).
   `export *` correctly excludes `default` (`AllButDefault`) — encoded by oxc.

5. **Dynamic and computed imports give spans, not values.** `import('./x.js')` yields a
   `dynamicImports` entry with a moduleRequest span but no resolved value; a static
   string must be sliced from source, and a **computed** `import(expr)` yields the
   expression span — which is the hazard boundary (string/computed import, registry
   §4). Side-effect imports (`import './x'`) appear as a `staticImport` with **zero
   entries** — cleanly detectable for the §3 side-effect edge.

6. **Comments are unattached and JSDoc-blind.** Association is ours (positional index);
   the effective leading edge **must include decorators** (the concrete trap caught in
   criterion 3). Not exercised: trailing same-line suppressions and comments inside
   decorator argument lists — out of scope for "suppression directly above a
   declaration," but worth an explicit non-support note.

7. **Enum exports (`ImportNameKind` etc.) are opaque at runtime** (`{}`); use the
   string `.kind` values in the JSON. API note, not a risk.

8. **No type checker (by ADR 0005 design).** Anything requiring inference —
   declaration merging, `emitDecoratorMetadata`, inference-only usage — remains
   checker-only and stays in the hazard registry (§4) with confidence capped at
   `medium`. The spike does not change this boundary; it confirms the *syntactic* side
   is extractable.

## Per-criterion verdicts

| # | Criterion | Verdict |
|---|---|---|
| 1 | Value vs type-position references | **PASS** |
| 2 | Re-export traversal (star + named, ambiguity) | **PASS** |
| 3 | Leading-comment / suppression capture | **PASS** |
| 4 | Throughput sanity | **PASS** (informational; ~0.11 ms/file) |

Every syntactic capability architecture §3/§4 asks of the parser is present in
`oxc-parser@0.140.0`'s output, and the derivations the extractor needs are demonstrably
writable in small, deterministic code. Nothing here surfaces evidence that syntactic
extraction cannot hold the zero-FP bar — the reversal condition ADR 0005 defined is
**not** met.

## Overall verdict

**PROCEED.** — to M2, on the oxc stack, per ADR 0005. Enter M2 with the biggest risk
named and owned: **hand-rolled scope/binding resolution (shadowing) is the frontend's
correctness core and its largest false-positive surface** — it deserves its own
fixtures and the Opus reviewer on every diff, and the type/value flip table (caveat 2)
must be completed fixture-by-fixture, not assumed.
