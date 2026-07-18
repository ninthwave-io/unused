# 0002 — Free/paid boundary: the credential boundary

Date: 2026-07-18
Status: Accepted

## Context
The founding brief drew the free/paid line as "computable locally from one repo" (free) vs "the correlation engine" (paid). Phase 1 exposed a contradiction: a user-supplied access-log file analysed locally is tier-4 evidence (nominally paid) yet fully local (nominally free). The red-team flagged it; the founder resolved it at the Phase 1 gate — and widened it deliberately, informed by the competitive finding that Fallow's runtime tier is paid and instrumentation-based.

## Options considered
- **Architecture line ("needs a server")** — original; stable but produces the contradiction above and pushes the zero-integration runtime beachhead behind the paywall, exactly where it has least strategic value.
- **Evidence-tier line (tiers 1–3 free, 4–5 paid)** — simple to state, but arbitrary: it charges for evidence the user's own environment can produce for free, which reads as crippling.
- **Credential boundary** — free = anything driven from the engineer's own environment with their own credentials; paid = anything our cloud does on their behalf.

## Decision
The **credential boundary** (founder-decided, Phase 1 gate):

- **Free OSS**: single-repo analysis; **multi-repo analysis in a local environment** (repos the user has checked out); local log-file analysis; **remote-source queries using the user's own credentials** (e.g. CloudWatch via an AWS profile) — all evidence tiers, locally driven.
- **Paid hosted**: managed cloud connectors (our platform holds prod-log/telemetry/analytics access so engineers don't need it), team dashboard, history and trends, hosted badge, scheduled analysis.

Trust wording becomes precise rather than weaker: **the OSS CLI makes network calls only to sources the user explicitly configures, with the user's credentials, and never to unused's servers. Zero telemetry, unchanged.**

## Consequences
- The OSS surface grows: log parsers and source drivers (files, AWS, OTel later) live in the open core. The plugin interface (Phase 2 architecture) must treat evidence sources as first-class plugins to keep this maintainable solo.
- The paid pitch sharpens to convenience, credential separation, and accumulated history — value a fork cannot shortcut (consistent with MIT, ADR 0001).
- v1 build scope is unchanged: tiers 1–2 ship first; locally-driven tier-4 sources land post-v1 on the free roadmap.
- "Local multi-repo" needs a workspace concept above single-repo analysis; the claim schema's reserved `loc.repo` qualifier (PRD §4) now serves free-tier use too.
