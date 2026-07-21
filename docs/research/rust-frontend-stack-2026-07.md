# Rust frontend extraction decision — 2026-07-21

Status: accepted and validated through delivery P6
Scope: Rust as an analyzed language, not a rewrite of the TypeScript analyzer

## Decision

Build the first Rust frontend on stable Cargo/rustc contracts:

1. `cargo metadata --format-version 1 --no-deps` supplies workspace packages,
   targets, manifests, source roots, features, and build-script presence.
2. `cargo check --workspace --all-targets --message-format=json` supplies
   compiler-attributed diagnostics and exact source spans.
3. A second all-features check is required before a compiler-dead item can be
   claimed. The initial frontend claims only subjects reported dead in both the
   default and all-features compilations.
4. A small source extractor supplies unambiguous module/file topology, item
   coordinates, test roots, and attributes needed to interpret compiler facts.
   It does not attempt to reproduce name resolution or macro expansion.
5. Compiler-confirmed dead private functions are the initial high-confidence
   item class. Public API, ambiguous macros, generated code, FFI/linkage
   attributes, and configurations the compiler runs cannot complete degrade
   toward alive or fail the boundary explicitly.

This is deliberately narrower than a general Rust call-graph implementation.
It provides useful deletion evidence without presenting a regex or syntax-only
reference guess as compiler truth.

## Measured environment

The implementation environment has stable `rustc 1.94.0` and `cargo 1.94.0`
for `aarch64-apple-darwin`. Cargo exposes metadata format version 1 and JSON
compiler messages. The installed stable `rustdoc` exposes HTML output only.
The `rust-analyzer` rustup proxy is present, but the component is not installed
for the active toolchain, so it is not an available contract.

Official contract checks:

- Cargo documents `--no-deps` metadata as workspace-member information without
  fetching dependencies, and format version 1 as the current machine-readable
  schema: [cargo metadata](https://doc.rust-lang.org/stable/cargo/commands/cargo-metadata.html).
- Cargo's external-tool protocol defines `compiler-message`,
  `compiler-artifact`, build-script, and `build-finished` JSON records:
  [Cargo external tools](https://doc.rust-lang.org/cargo/reference/external-tools.html).
- Rustdoc JSON remains an experimental nightly output behind
  `-Z unstable-options`; it is not a stable production dependency:
  [rustdoc unstable output formats](https://doc.rust-lang.org/rustdoc/unstable-features.html#output-format-output-format).
- `dead_code` is warn-by-default and specifically detects unused unexported
  items. The compiler also documents deletion caveats for fields with drop or
  auto-trait effects, which is why the first claim class excludes fields:
  [rustc dead-code lint](https://doc.rust-lang.org/rustc/lints/listing/warn-by-default.html#dead-code).

## Rejected extraction boundaries

### Rustdoc JSON

Rejected as the default because it requires nightly and remains experimental.
It describes documentation/API structure, not a complete body-level reference
graph, so even adopting nightly would not by itself solve unused call analysis.

### rust-analyzer LSP/CLI

Rejected as a required v0.1.0 dependency. It is not guaranteed to be installed
with Rust, its standalone CLI analysis surface is not a stable interchange
contract, and issuing find-references queries per item risks recreating the
repeated-work scaling failure just removed from the TypeScript path. It remains
a possible optional enrichment after measured corpus evidence.

### rustc private-driver/MIR/HIR integration

Rejected for the first release. Compiler-private APIs require nightly pinning,
track rustc internals, and impose a large distribution/maintenance boundary.
They are justified only if the stable diagnostic foundation cannot meet the
consumer's required Rust recall after Rustler-specific bridge facts are added.

### Pure textual call graph

Rejected for confident claims. Rust path resolution, traits, macros, cfg, and
method dispatch make token matching unsuitable as deletion proof. Source syntax
is used only to locate compiler-reported subjects and conservative topology or
hazards.

## Execution and refusal contract

Rust analysis runs Cargo and therefore may compile procedural macros and run
build scripts. The CLI must disclose this just as it discloses Mix compiler
execution. A missing toolchain, invalid metadata, compiler failure, malformed
JSON protocol, or failed all-features validation fails the Rust boundary; it
does not silently return an empty successful analysis.

The frontend must not inject warning flags that override project lint policy.
It consumes the compiler's normal `dead_code` diagnostics. A project that
suppresses the lint reduces recall explicitly; it does not lower precision.

Cargo build output is an environmental artifact and must never enter committed
fixtures or canonical JSON. Tests use neutral generated crates and remove their
targets. The consuming project remains validation-only under the privacy rule.

## Feature, target, and macro policy

- Compile all Cargo targets so library, binary, example, test, and benchmark
  uses participate.
- Require a subject to be dead in both default and all-features runs. This
  prevents a default-only warning from claiming a function used by an optional
  feature.
- An all-features failure is initially an explicit unsupported configuration,
  not permission to claim from the default run. A future feature-matrix plugin
  may model mutually exclusive feature sets without weakening this rule.
- Build-script and proc-macro execution is disclosed. Source generated in
  `OUT_DIR`, macro-expanded subjects, and items with unknown attributes are not
  independently claimed from syntax.
- `extern`, export/linkage attributes, `#[used]`, `#[no_mangle]`, and equivalent
  runtime surfaces are unclaimable until a convention or bridge plugin supplies
  exact semantics.

## Initial evidence and limitations

The initial high-confidence claim means: stable rustc compiled every target in
both required feature modes and independently emitted `dead_code` for the same
private function span. Evidence cites the compiler lint and exact site.

This foundation intentionally misses unused public API and compiler-suppressed
dead code. Rustler/NIF functions are addressed in P4 by the Rustler convention
and cross-language bridge, not by pretending `dead_code` can see runtime
registration. Corpus recall will quantify the gap before any heavier compiler
integration is approved.

## Revisit triggers

Prototype a stronger isolated extractor only if all are true:

- Rust corpus precision remains 1.0;
- consumer validation shows material dead Rust outside compiler diagnostics;
- Rustler facts do not close the important gap;
- profiling shows extraction, rather than Cargo compilation, is the bounded hot
  path; and
- the expected recall gain justifies nightly/toolchain/distribution cost.

## P6 validation and rewrite decision

The implemented stable boundary meets its initial precision contract. The Rust
corpus contains 4 cases / 12 labelled subjects at precision 1.0 and recall
0.8333333333333334, with one explicit unused-public-API miss. The Rustler bridge
corpus contains 1 case / 4 subjects at precision and recall 1.0. Neither corpus
has a false positive, confidence violation, or unlabelled claim.

A cold tracked-only copy of the public Rustler fixture completed in 1.01s wall,
1.41s external user+system CPU, and 132.9MB external peak RSS. Its phase stream
reported 879.456ms in compiler/parsing work versus 2.118ms convention extraction,
1.012ms graph construction, 0.541ms reachability, 0.096ms hazard activation, and
1.052ms claim generation. It retained 5 files, 12 symbols, 37 edges, 2 claims,
3 workspaces, 9 graph walks, 5 fixed-point iterations, and zero deletion-plan
simulations. Canonical JSON remained schema-valid and diagnostic-free.

Decision: neither rewriting the corrected TypeScript graph engine in Rust nor
replacing the stable Cargo/rustc frontend is required before v0.1.0. The former
would move a bounded low-millisecond operation across a serialization boundary;
the latter would duplicate compiler semantics while the required compilers
already dominate the cold path. The expected gain is small, and the costs are a
new native distribution matrix, duplicated IR/provenance contracts, cross-boundary
serialization, and ongoing compiler-integration maintenance.

The next Rust investment should therefore be recall, not implementation
language: consider a narrowly measured public-API extractor only when consuming
evidence shows the recorded miss class is materially valuable and the revisit
triggers above are all satisfied.
