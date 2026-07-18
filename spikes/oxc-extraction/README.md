# oxc-extraction spike (T1.5)

ADR 0005's reversal-evidence test: does `oxc-parser`'s output support the reference
extraction the M2 TS/JS frontend needs? Standalone package — **NOT** part of the
pnpm workspace (workspace glob is `packages/*`). Installed with plain `npm`.

- Node 22.16.0 (repo `.tool-versions`), `oxc-parser@0.140.0` (latest at 2026-07-18).
- Plain `.mjs`, no build step.

## Run

```sh
cd spikes/oxc-extraction
npm install            # installs oxc-parser locally
npm run all            # runs all four scripts
```

Or individually (each exits non-zero on a failed assertion):

| # | Script | Criterion |
|---|--------|-----------|
| 1 | `npm run 1` / `node 01-type-positions.mjs`    | Value- vs type-position reference classification |
| 2 | `npm run 2` / `node 02-reexport-traversal.mjs`| `export *` + named re-export traversal, ambiguity |
| 3 | `npm run 3` / `node 03-leading-comments.mjs`  | `unused:ignore` leading-comment capture |
| 4 | `npm run 4` / `node 04-throughput.mjs`        | Parse throughput sanity number |

Each script prints its evidence and ends with a `VERDICT: PASS` line; assertions
encode the expected outcomes so a regression fails loudly.

`fixtures/reexport/` holds the 3+file chain used by script 2. Verdict and analysis:
`docs/research/spike-oxc-extraction-2026-07.md`.
