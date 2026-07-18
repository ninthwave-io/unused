# Progress — unused

Updated: 2026-07-18

## Current phase
Phase 4 (implementation). **Milestone M2 — COMPLETE, awaiting founder gate approval.** Do not start M3 until approved. Tag `m2` on approval.

## Done
- Phases 0–3 gate-approved; M1 approved + tagged `m1`. ADRs 0001–0010 Accepted. Founder directives live: study-not-copy incumbents + differential Knip runs; benchmarking with M4-gate early-pivot checkpoint.
- **M2 (commits 6f4a7fb..HEAD)**: T2.7 Gate C hardening (CI baseline from origin/main; sentinel-proofed); T2.6 bench harness (knip@6.27.0 pinned); T2.1 extraction (scope tracker, suppression capture, value/type classification); T2.2 resolution (closed union, internal-declaration, .d.ts source-first); T2.3 IR + emitter (spans on every edge, entrypoint contract frozen); T2.4 reachability + first claims (three inherited FP rules, hazard no-claim zones, config roots, wildcard exports); T2.5 minimal CLI (--json, exit contract 0/2/3, zero-entrypoints warning) + bench wired. Corpus grew 13→16 cases / 39 subjects (tsconfig-paths-alias, broken-paths-alias, import-equals).
- **Scoreboard (realAnalyzer, full corpus, no skip-list): precision 1.0, recall 0.556, 0 FPs, 0 confidence violations, 10 high TPs, 8 misses.** 313 tests. Exceeds the phasing M2 acceptance (which permitted a hazard skip-list).
- **Review layer caught 5 confirmed FP-vector classes pre-merge**: TSImportType silent drop; .d.ts types-condition shadowing; phantom scheme externals; import=/export= drop; entrypoint-boundary trio (root tool-configs, wildcard exports, zero-entrypoint claims).
- Bench (fixture-scale, startup-dominated): unused ~40ms vs knip ~150ms median.

## Known debt (conscious, recorded)
- Computed import/require ⇒ whole-project no-claim (heavy recall, zero FP risk) — M3 registry scopes hazards properly.
- Config string scan covers JSON + parsed source configs only; YAML/JSONC configs → M3.
- 8 corpus misses enumerated in T2.4 report (string-computed×3, require-expression×2, re-export-chain barrel origin, import-equals surface, config-referenced-file).
- Clean-subject under-confidence not surfaced (M3); estDeletableLoc provisional (T3.4); single-file bundle deferred (M9); warm cache post-v1 debt (architecture §5).
- Optional CLI nit: `--cwd --json` consumes the flag as a value → exit 2 not 3 (harmless; note for M6 flag rework).

## Next (after M2 gate approval)
M3 — hazard registry + the FP bar (docs/phasing.md): registry structure + full class set with scoped downgrades (replaces whole-project suppression), two-sided type rule surfacing, confidence assignment + generated assumption set, estDeletableLoc dedup, pin smoke repos + first triage (docs/smoke/M3.md) + differential Knip run + real bench numbers.

## Standing founder actions
Register npm org `ninthwave-io`; branch protection (required checks) when repo goes remote (ADR 0009 consequence); optional npm dispute for `unused`; beta-user names before M9.
