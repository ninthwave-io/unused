/**
 * SARIF 2.1.0 reporter (T6.3, docs/phasing.md M6; mapping per PRD §4
 * "SARIF mapping").
 *
 * One rule per claim **kind** (not per verdict): `unused/export`,
 * `unused/file`, `unused/dependency`, `unused/endpoint`, `unused/test-only`
 * — PRD §4's exact rule-id list, with the `test` subject kind mapped to the
 * `unused/test-only` rule id (a `test` subject only ever carries the
 * `test-only` verdict, so the rule id names the verdict for that one kind;
 * every other kind is named by its subject kind). Rule ids are "a stable
 * contract from v1" (PRD §4): `driver.rules` always lists the full
 * five-rule catalogue, regardless of which kinds the current run actually
 * produced, so a SARIF consumer (GitHub code scanning, an IDE plugin) sees
 * a stable rule catalogue across runs rather than one that grows and
 * shrinks with the analysed repo.
 *
 * `level` is `warning` for `high` confidence, `note` for `medium`/`low`
 * (PRD §4). `partialFingerprints["unusedClaimId/v1"]` is the claim id
 * verbatim, so code-scanning alert tracking survives across commits the
 * same way baseline diffing does (ADR 0006). `artifactLocation.uri` is
 * `subject.loc.file` unchanged — already repo-relative POSIX per the claim
 * schema (PRD §4 `Loc.file`).
 *
 * `message.text` and `properties.why` both render `evidence[0].detail` —
 * the analyzer's own captured one-line explanation (PRD §8: "every claim
 * renders its one-line why from data already captured at analysis time, no
 * re-analysis"). The PRD §4 worked example's inline prose differs
 * cosmetically between the two (illustrative copy, not a string contract —
 * "the outline fixes their presence and role in the schema, not the exact
 * [value]"); inventing a second, differently-worded paraphrase here would
 * either duplicate `properties.evidence[0].detail` under new prose with no
 * new information, or require synthesising text the analyzer never
 * captured, both worse than reusing the one explanation that is already
 * exactly right. `properties.evidence` still carries the full evidence
 * array for a consumer that wants more than the headline reason.
 *
 * Suppression (PRD §4 "the mandatory source-comment reason travels into
 * `--json` and the SARIF properties bag") lands at `properties.suppression`.
 *
 * Imports only `core/claims` (dependency-cruiser reporters boundary).
 */
import type { Claim, ClaimRun, Confidence, Evidence, SubjectKind } from "../core/claims/index.js";

/** PRD §4's exact rule-id list, keyed by subject kind (a `test` subject's only verdict is `test-only`). */
const RULE_ID: Readonly<Record<SubjectKind, string>> = {
  export: "unused/export",
  file: "unused/file",
  dependency: "unused/dependency",
  endpoint: "unused/endpoint",
  test: "unused/test-only",
};

const RULE_DESCRIPTIONS: ReadonlyArray<{ kind: SubjectKind; text: string }> = [
  { kind: "export", text: "Unused exported symbol" },
  { kind: "file", text: "Unused file" },
  { kind: "dependency", text: "Unused declared dependency" },
  { kind: "endpoint", text: "Endpoint with no consumer in this repo" },
  { kind: "test", text: "Zombie test — exercises only test-only or dead code" },
];

const LEVEL_BY_CONFIDENCE: Readonly<Record<Confidence, "warning" | "note">> = {
  high: "warning",
  medium: "note",
  low: "note",
};

/** Minimal SARIF 2.1.0 shapes — only the fields this reporter emits (validated against the full schema in tests). */
export interface SarifLog {
  readonly version: "2.1.0";
  readonly $schema: string;
  readonly runs: readonly SarifRun[];
}

export interface SarifRun {
  readonly tool: {
    readonly driver: {
      readonly name: string;
      readonly version: string;
      readonly informationUri: string;
      readonly rules: readonly SarifRule[];
    };
  };
  readonly results: readonly SarifResult[];
}

export interface SarifRule {
  readonly id: string;
  readonly shortDescription: { readonly text: string };
}

export interface SarifResult {
  readonly ruleId: string;
  readonly level: "warning" | "note";
  readonly message: { readonly text: string };
  readonly locations: readonly [
    {
      readonly physicalLocation: {
        readonly artifactLocation: { readonly uri: string };
        readonly region: { readonly startLine: number; readonly endLine: number };
      };
    },
  ];
  readonly partialFingerprints: { readonly "unusedClaimId/v1": string };
  readonly properties: {
    readonly confidence: Confidence;
    readonly evidence: readonly Evidence[];
    readonly why: string;
    readonly suppression?: { readonly reason: string };
  };
}

const SARIF_SCHEMA_URI =
  "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json";

function whyOf(claim: Claim): string {
  return claim.evidence[0]?.detail ?? "";
}

function toResult(claim: Claim): SarifResult {
  const why = whyOf(claim);
  return {
    ruleId: RULE_ID[claim.subject.kind],
    level: LEVEL_BY_CONFIDENCE[claim.confidence],
    message: { text: why },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: claim.subject.loc.file },
          region: { startLine: claim.subject.loc.span[0], endLine: claim.subject.loc.span[1] },
        },
      },
    ],
    partialFingerprints: { "unusedClaimId/v1": claim.id },
    properties: {
      confidence: claim.confidence,
      evidence: claim.evidence,
      why,
      ...(claim.suppression !== undefined ? { suppression: claim.suppression } : {}),
    },
  };
}

/** Build the SARIF 2.1.0 log for a claim run (already filtered by the caller, per `--filter`/`--min-confidence`, PRD §3). */
export function buildSarifLog(run: ClaimRun): SarifLog {
  return {
    version: "2.1.0",
    $schema: SARIF_SCHEMA_URI,
    runs: [
      {
        tool: {
          driver: {
            name: run.tool.name,
            version: run.tool.version,
            informationUri: "https://unused.dev",
            rules: RULE_DESCRIPTIONS.map(({ kind, text }) => ({
              id: RULE_ID[kind],
              shortDescription: { text },
            })),
          },
        },
        results: run.claims.map(toResult),
      },
    ],
  };
}

/** Render the SARIF log as pretty-printed JSON text (trailing newline, matching `--json`'s convention). */
export function renderSarif(run: ClaimRun): string {
  return `${JSON.stringify(buildSarifLog(run), null, 2)}\n`;
}
