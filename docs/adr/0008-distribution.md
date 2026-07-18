# 0008 — Distribution: npm-only at v1

Date: 2026-07-18
Status: Accepted (founder, Phase 2 gate, 2026-07-18; naming decided at the Phase 1 gate)

## Context
Founder decisions at the Phase 1 gate: publish as `@ninthwave-io/unused` (bin `unused`), matching the ninthwave-io GitHub org; drop the `curl | sh` installer from v1. npm facts (verified 2026-07-18): unscoped `unused` is abandoned-but-held (2013/2022 relic); `@ninthwave-io/unused` unpublished; the npm org `ninthwave-io` appears unregistered.

## Options considered
Covered at the gate: unscoped fallbacks (`unused-dev`, `unused-cli`, `unusd`), the `@unused.dev` scope, and the dispute route for `unused`. Binary/standalone packaging (bun compile, pkg) considered and deferred — npx covers the v1 audience.

## Decision
- Publish `@ninthwave-io/unused` with `bin: unused`; canonical invocation `npx @ninthwave-io/unused`; README leads with it.
- **Founder actions, time-sensitive**: register the npm org `ninthwave-io` (first-come); optionally file npm's abandoned-package dispute for unscoped `unused` in parallel — if granted, `unused` becomes an alias package that depends on the scoped one, and `npx unused` starts working.
- Publish via GitHub Actions **trusted publishing with npm provenance** from day one — supply-chain posture is part of the trust brand.
- No curl installer, no standalone binaries, no Homebrew in v1. `unused.sh`/`unused.dev` serve docs and the deletion-report/badge surfaces instead.
- Node ≥22 declared via `engines` and checked at startup with a clear error.

## Consequences
- One distribution channel to maintain; the memorable-name gap (`npx @ninthwave-io/unused` vs `npx knip`) is real and accepted — the dispute route is the only path to `npx unused` and is worth the letter.
- Provenance badges appear on the npm page from the first release.
