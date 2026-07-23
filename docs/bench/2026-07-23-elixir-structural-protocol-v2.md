# Elixir structural protocol v2 — bounded scaling attribution

Date: 2026-07-23

This benchmark uses independently generated neutral Mix projects. Each point
has one target source plus 250, 500, 1,000, or 2,000 generated source files.
The generator validates density `1` (the original root-cause curve) and density
`8` (the release memory/scale acceptance). Elixir 1.20.2/OTP 28.5 ran with four
BEAM schedulers on Apple Silicon. No consuming-project material was accessed or
used.

The comparison runs the same generator and `runTracer` call against clean base
`66495b347ff7684957d0fa45b648ca23c101201c` and the protocol-v2 worktree. The
durable benchmark reports end-to-end wall time plus Node-process user/system
CPU; the memory wrapper samples the complete process tree. The sparse
historical command is:

```sh
/usr/bin/time -l env \
  ASDF_ELIXIR_VERSION=1.20.2-otp-28 \
  ASDF_ERLANG_VERSION=28.5 \
  UNUSED_RUNNER_MODULE=<checkout>/packages/unused/dist/frontends/elixir/runner.js \
  node packages/unused/scripts/benchmark-elixir-structural.mjs <size> 1
```

## Root-cause reproduction

Density `1` retains the original one-carrier/two-fact workload so the diagnosis
can be rerun without changing the durable script. Base emits
1,757/3,507/7,007/14,007 raw compiler events; v2 preserves additional distinct
same-line columns and emits 2,007/4,007/8,007/16,007. The comparison therefore
cannot make v2 faster by dropping event density. Protocol v2 keeps those exact
events only when a structural fact references them, while `TraceResult.events`
is projected back to the pre-v2 semantic key before existing analysis runs.

The first instrumented implementation rebuilt the full event index inside each
file extraction, O(files × events). It measured 704/2,655 ms at 250/500 files
and drove the 2,000-file end-to-end test to 112.6 seconds. Moving that index to
one boundary-wide build changed the join to O(events) plus O(1) indexed lookups
per carrier/call. The final implementation also compacts child index entries
and streams parent JSONL. Final timing and memory evidence therefore comes only
from the dense isolated run below; no pre-compaction timing is presented as a
release result.

The denser matrix runs through the explicit `pnpm test:elixir-scale` gate,
sequentially after the ordinary suite in `ci`, so its real Mix children do not
contend with ownership/refusal regressions.

## Dense exported-symbol and process-tree acceptance

Density `8` uses eight exported carriers per generated file. Each carrier has a
seed-to-consumer pipeline and emits exactly one `pipeline-argument` plus one
`carrier-result` fact. This is eight times the carrier/fact density of the
initial matrix; no point drops work to satisfy the memory check.

The memory sampler schedules inspection of the benchmark Node process and all
descendants every 20 ms, reporting Node, `beam.smp`, and summed-tree peaks
separately. Darwin `ps` sampling suppresses overlapping polls, so the final
acceptance's measured effective cadence was 40.74–40.86 ms, not 20 ms. The
command pins the toolchain itself:

```sh
node packages/unused/scripts/measure-elixir-structural-memory.mjs \
  <checkout>/packages/unused/dist/frontends/elixir/runner.js 2000 8
```

The final implementation and unchanged base ran three times each in strict
alternation (`base-1`, `v2-1`, ...), with no other BEAM, Mix, or Vitest workload
present. Values below are medians with the complete final observed range in
parentheses; failed-series outliers remain disclosed below.

| revision | wall | raw events | semantic events | exact retained | carriers | facts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| base | 6.290 s (6.223..6.311) | 114,007 | 114,007 | 0 | — | — |
| v2 | 10.869 s (10.774..11.027) | 130,007 | 114,007 | 16,000 | 16,002 | 32,000 |

| revision | Node peak KiB | BEAM peak KiB | tree peak KiB |
| --- | ---: | ---: | ---: |
| base | 248,880 (248,864..249,760) | 587,952 (580,800..601,520) | 645,184 (637,872..658,800) |
| v2 | 321,920 (321,328..328,752) | 580,992 (576,400..606,480) | 643,728 (638,928..669,072) |
| median delta | +29.35% | -1.18% | -0.23% |

Node-process user/system CPU medians were 0.385/0.188 seconds for base and
1.284/0.303 seconds for v2. These are deliberately labelled as Node CPU, not
whole-tree CPU. The sampler's approximate cumulative tree CPU medians were
12.57 and 17.52 seconds (+39.38%); this can undercount descendants shorter than
one effective sample.

The provisional release gate is summed whole-tree peak within 15% of the exact
same base fixture while retaining every raw event, carrier, and fact; the
observed median delta is -0.23%, and every v2 observation is within 15% of the
base median. This is the capacity boundary for one analyzer run. The parent
result is not hidden: Node alone increases 29.35%, or 71.3 MiB, from the
fact-referenced exact events plus retained carriers/facts. BEAM's median
decreases 1.18% after the ownership-transfer correction.

Two pre-correction alternating series are retained as failed evidence. The
CPU-enhanced series measured v2 tree RSS at 706,384–910,128 KiB with an 875,152
KiB median (+36.81%); an earlier series retained an 870,544 KiB outlier. Phase
attribution found the canonical event list remained live in an old-generation
heap throughout extraction solely because final summary assembly called
`length(events)`, while the compact structural index duplicated its needed
data. Exact duplicates were also accumulated in an ETS `duplicate_bag` before
`Enum.uniq`. The correction uses an ETS `set`, takes/deletes it before sorting,
captures the raw count as a scalar before indexing, and performs one full
collection at the explicit point where the compact index becomes authoritative.
The stable final ranges above come from that exact shippable runtime.

Wall time still increases 72.80%, from 6.290 to 10.869 seconds, despite remaining
well inside the interactive budget. Together with the +39.38% approximate tree
CPU and +29.35% Node RSS deltas, this is a material follow-up optimization target,
not a hidden success criterion.
The ordinary Vitest process does not gate `process.resourceUsage().maxRSS`
because that counter is process-lifetime cumulative and test files may execute
concurrently.

At 2,000 files the median final child summary attributes 1.451 seconds to
structural work: 0.810 seconds building the compact event index, 0.426 seconds
reading, hashing, parsing, and extracting files, and 0.160 seconds emitting
JSONL. Each phase value is its own three-run median, so those medians do not
arithmetically compose into the elapsed median from a single run.
Source bytes (1,472,108), AST visits (132,013), carriers (16,002), and facts
(32,000) follow exact linear formulas. The full 250/500/1,000/2,000 gate asserts
`files=n+1`, raw compiler `events=65n+7`, semantic `events=57n+7`, exact retained
`events=8n`, `carriers=8n+2`, `facts=16n`, and `AST visits=66n+13`; it remains
well inside the two-minute interactive budget.

The separately gated standalone matrix passed all five acceptance conditions
in 21.663 seconds.
The exact span regression includes a tab-indented one-line carrier with a combining
grapheme, an emoji, and interpolation; it proves the parser and parent both use
grapheme columns and that `end_of_expression` encloses generated interpolation
flow.

The final post-freeze matrix used the exact accepted runtime identified by scoped
manifest SHA-256
`52593c73a8e91041f196e0773f59be60c6ed443af57eb99573c02ce6b080a04b`:

- the ordinary suite passed 99 files and all 1,559 tests, with no failures,
  pending tests, or skips (pinned JSON SHA-256
  `a2899f41d4a8dd84544d0f3260b69f9ce81c96289f5abc71866d2e36dd6eb61d`);
- the standalone dense scale gate passed one file and all five tests (pinned
  JSON SHA-256
  `a3cde4e15d5660664efcf968faead353f3adccbdd6d0ceb99975225eff9687bd`);
- typecheck, build, generated-assumption synchronization, and dependency
  boundaries passed. Boundaries covered 947 modules and 2,204 dependencies;
  lint retained the established two warnings and 57 informational diagnostics;
- the TypeScript corpus passed 52 cases / 237 subjects at precision 1.0 and
  recall 0.826530612244898; Elixir passed 35 / 121 at precision 1.0 and recall
  0.9777777777777777 with no toolchain skips; Rust passed 4 / 12 at precision
  1.0 and recall 0.8333333333333334; and the polyglot bridge passed 1 / 4 at
  precision and recall 1.0. Every corpus reported zero false positives,
  confidence violations, and unlabelled claims;
- the installed-package smoke used a 363-entry, 666,944-byte tarball (unpacked
  size 2,997,600 bytes; SHA-256
  `e9e253d2de468ee851275cd48a014d7656732a921402f6ec117dabf2b799d37e`).
  Its CLI, claim-run schema, README, LICENSE, and package metadata were present.
  The installed CLI emitted one neutral claim and one boundary as schema-valid
  1.4.0 JSON with zero stderr, and the installed public module exposed only the
  existing `analyzeProject` and `analyzeProjectWithGraph` declarations; and
- `git diff --check` and the scoped privacy scan passed across all 18 changed
  tracked files plus all five untracked public delivery files. Added content
  contained no consuming-project identifier, absolute user path, private-key or
  access-key marker, credential assignment, or private source material.

These are post-freeze results; stale intermediate totals and the failed memory
series above are not release evidence.

## Rust decision

No Rust implementation is warranted for this operation. The algorithmic
correction removes the quadratic index rebuild. At the dense 2,000-file point,
median bounded structural work is 1.451 seconds of the 10.869-second end-to-end
run. A native boundary would add serialization and maintenance cost while leaving the
dominant compiler, reflection, process, parent decoding, and filesystem work
unchanged.
