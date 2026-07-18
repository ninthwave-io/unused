# 0001 — License: MIT

Date: 2026-07-18
Status: Accepted

## Context
The OSS CLI is the trust-building and adoption instrument for the whole product (BRD §1, §4). The license choice trades adoption friction against protection from hosted clones. Founder decision taken at the Phase 1 gate.

## Options considered
- **MIT** — maximum adoption, zero friction, universally understood; no protection against a competitor forking the core or offering a hosted clone.
- **Apache-2.0** — similar adoption profile plus an explicit patent grant; slightly heavier for contributors; still no clone protection.
- **Open-core with BSL components** — protects the correlation engine from hosted clones; but the paid value here is connectors + accumulated history, not the core code, and a source-available license would undercut the trust wedge against incumbents.

## Decision
MIT, for the entire OSS repository. Founder-decided at the Phase 1 gate (2026-07-18). The clone risk is accepted because paid value is structural (managed connectors, credential separation, history, team surfaces — see ADR 0002), not embodied in copyable code. Evidence that would reverse this: a well-funded competitor cloning the OSS core into a hosted product that captures the correlation-engine market before we ship it.

## Consequences
- Anyone may fork, embed, or commercialise the core — including Knip or Fallow adopting our claim schema. Accepted; a shared claim schema would even validate the category.
- No CLA needed for v1; contributions are MIT-in, MIT-out.
- Copyright line is currently "Rob Lambell"; switch to a company entity via a follow-up commit when one is confirmed.
