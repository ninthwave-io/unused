# 0010 — Config format: JSONC only in v1

Date: 2026-07-18
Status: Accepted (founder, Phase 2 gate, 2026-07-18)

## Context
PRD §6 left the config format open (jsonc vs ts). The red-team flagged the promised ADR as missing from the Phase 2 package.

## Options considered
- **`unused.config.jsonc`** — declarative, deterministic, parseable without executing user code, trivially readable by the hosted platform later and by other tools (editors, CI dashboards).
- **`unused.config.ts`** — maximally flexible and typed, but loading it means executing arbitrary user code inside the analyzer: a determinism hole, a security-posture smell for a trust-branded tool, and a loader-compatibility toil generator (tsx/jiti/native strip-types matrix).
- Both — doubles the support surface for a solo founder; the escape hatch becomes the default in the wild.

## Decision
**JSONC only in v1**: `unused.config.jsonc` (also accepted: `.json`). A JSON Schema ships with the package for editor autocomplete and validation — that recovers most of the typed-config ergonomics without code execution. Framework presets are named strings, so the config stays declarative. Evidence that would reverse this: recurring real-world configs that genuinely need computation (not just sharing), at which point a `.ts` loader can be added additively.

## Consequences
- The analyzer never executes user code — the determinism and trust story stays clean, and config parsing is trivially portable to the hosted platform.
- Dynamic config needs (rare) are met by generating the JSONC in the user's own build step.
- The config-format bullet in PRD open questions resolves to this ADR.
