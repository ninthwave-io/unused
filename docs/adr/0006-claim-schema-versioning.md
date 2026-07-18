# 0006 — Claim schema versioning and claim identity

Date: 2026-07-18
Status: Accepted (founder, Phase 2 gate, 2026-07-18)

## Context
The claim schema is consumed by CI baselines, SARIF fingerprints, MCP clients, and (later) the hosted platform. The PRD left the id hash and the semver policy open; baseline diffing cannot be built without them.

## Options considered
For identity: content-based hashes (change on every edit — useless for baselines); location-based (file+line — noisy on reformat); subject-tuple hash (stable to edits and in-file moves).
For versioning: implicit stability (breaks silently) vs an explicit semver policy with reserved growth points.

## Decision
- **Claim id** = `<prefix>_<first 16 hex of SHA-256 over the canonical subject string>`, where the canonical string is `1\0kind\0language\0name\0file\0protocol\0method` (absent fields empty; `file` is POSIX-style, repo-relative; prefix is `exp|fil|dep|end|tst` by kind). Ids are stable to any edit that keeps the subject's kind, name, and file; cross-file moves change the id (documented in PRD §4).
- **idVersion** (currently `1`, embedded in the canonical string and stamped into baselines alongside analyzerVersion and schemaVersion) changes only when the id recipe changes; on mismatch `unused check` warns and recommends re-baselining (PRD §4 graceful degrade).
- **schemaVersion policy** (semver): MAJOR = removing/renaming a field or changing the meaning of an existing enum value; MINOR = additive fields or additive enum values in open enums; PATCH = documentation only. `verdict` and `subject.kind` are **closed enums with pre-reserved future values** (PRD §4) — consumers may switch exhaustively. `evidence[].type` beyond the reserved five and `evidence[].source` are **open** — consumers must tolerate unknown values there.
- The JSON Schema definition ships in the repo and is versioned with the package.

## Consequences
- Baseline diffing, SARIF `partialFingerprints.unusedClaimId/v1`, and hosted history all key off one identity definition.
- Renaming a symbol intentionally changes its id — a rename reads as resolved + new in `unused check`, which is correct (the old claim is gone) but worth documenting.
- The `language` field enters the canonical string now (empty ⇒ `ts` implied in v1) so Python/Elixir claims never collide with TS ones — ADR 0003's schema audit item, resolved here.
