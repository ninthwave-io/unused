/**
 * SARIF reporter tests (T6.3 acceptance): rule-id/level mapping, fingerprint
 * presence, artifact-location shape, suppression passthrough, and — the
 * acceptance-checklist item — validation against the vendored SARIF 2.1.0
 * JSON Schema (`schema/sarif-2.1.0.schema.json`, source URL + the two
 * ajv@8-compatibility patches documented in that file's own `$comment`).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { describe, expect, it } from "vitest";
import type { Claim, ClaimRun } from "../core/claims/index.js";
import { buildSarifLog, renderSarif } from "./sarif.js";

// Same import shape as `cli/index.test.ts`'s schema validation (ajv-formats
// has no ESM-friendly default export; `createRequire` matches the working
// pattern already proven there rather than introducing a second one).
const addFormats = createRequire(import.meta.url)("ajv-formats") as FormatsPlugin;

const HERE = dirname(fileURLToPath(import.meta.url));
const BOUNDARY = {
  status: "complete",
  pluginId: "language:typescript",
  boundaryId: "ts:.",
  language: "ts",
  fileCount: 1,
  workspaceCount: 1,
  partitions: { production: "complete", config: "complete", test: "complete" },
} as const;

function compileSarifSchema() {
  const schema = JSON.parse(readFileSync(join(HERE, "schema/sarif-2.1.0.schema.json"), "utf8"));
  // strict: false — the vendored draft-04 schema uses patterns (e.g. boolean
  // `exclusiveMinimum` is absent here, but draft-04 in general permits
  // constructs ajv's strict mode warns on) outside ajv's default strict set;
  // see the schema file's own `$comment` for the two structural patches this
  // required to compile at all.
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

function claim(overrides: Partial<Claim> & Pick<Claim, "subject" | "verdict">): Claim {
  return {
    id: `id_${overrides.subject.name}`,
    language: "ts",
    confidence: "high",
    evidence: [{ type: "static-reachability", detail: "why text", source: "reference-graph" }],
    provenance: {
      analyzer: "ts-reference-graph",
      version: "0.1.0",
      generatedAt: "2026-07-18T00:00:00.000Z",
    },
    ...overrides,
  } as Claim;
}

function makeRun(claims: readonly Claim[]): ClaimRun {
  return {
    schemaVersion: "1.1.0",
    tool: { name: "unused", version: "0.1.0" },
    run: {
      root: "/repo",
      configHash: "abc",
      startedAt: "2026-07-18T00:00:00.000Z",
      durationMs: 10,
      boundaries: [BOUNDARY],
    },
    claims,
    summary: {
      byKind: { export: 0, file: 0, dependency: 0, endpoint: 0, test: 0 },
      byConfidence: { high: 0, medium: 0, low: 0 },
      estDeletableLoc: 0,
    },
  };
}

describe("buildSarifLog — shape", () => {
  it("emits version 2.1.0 and the fixed $schema URI", () => {
    const log = buildSarifLog(makeRun([]));
    expect(log.version).toBe("2.1.0");
    expect(log.$schema).toBe(
      "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
    );
  });

  it("always lists the full 5-rule catalogue (a stable contract), regardless of which kinds are present", () => {
    const log = buildSarifLog(makeRun([]));
    const ids = log.runs[0]?.tool.driver.rules.map((r) => r.id);
    expect(ids).toEqual([
      "unused/export",
      "unused/file",
      "unused/dependency",
      "unused/endpoint",
      "unused/test-only",
    ]);
  });

  it("maps a `test` subject's claim to the unused/test-only rule id (not unused/test)", () => {
    const c = claim({
      subject: { kind: "test", name: "x.spec.ts", loc: { file: "x.spec.ts", span: [1, 1] } },
      verdict: "test-only",
    });
    const log = buildSarifLog(makeRun([c]));
    expect(log.runs[0]?.results[0]?.ruleId).toBe("unused/test-only");
  });

  it("maps confidence high -> level warning, medium/low -> level note", () => {
    const high = claim({
      subject: { kind: "export", name: "a", loc: { file: "a.ts", span: [1, 1] } },
      verdict: "unused",
      confidence: "high",
    });
    const medium = claim({
      subject: { kind: "export", name: "b", loc: { file: "b.ts", span: [1, 1] } },
      verdict: "unused",
      confidence: "medium",
    });
    const low = claim({
      subject: { kind: "export", name: "c", loc: { file: "c.ts", span: [1, 1] } },
      verdict: "unused",
      confidence: "low",
    });
    const results = buildSarifLog(makeRun([high, medium, low])).runs[0]?.results ?? [];
    expect(results.map((r) => r.level)).toEqual(["warning", "note", "note"]);
  });

  it("sets partialFingerprints['unusedClaimId/v1'] to the claim id", () => {
    const c = claim({
      subject: { kind: "export", name: "a", loc: { file: "src/a.ts", span: [3, 9] } },
      verdict: "unused",
    });
    const result = buildSarifLog(makeRun([c])).runs[0]?.results[0];
    expect(result?.partialFingerprints).toEqual({ "unusedClaimId/v1": c.id });
  });

  it("uses subject.loc.file verbatim (repo-relative) as artifactLocation.uri, and span as the region", () => {
    const c = claim({
      subject: { kind: "file", name: "src/dead.ts", loc: { file: "src/dead.ts", span: [1, 42] } },
      verdict: "unused",
    });
    const loc = buildSarifLog(makeRun([c])).runs[0]?.results[0]?.locations[0]?.physicalLocation;
    expect(loc?.artifactLocation.uri).toBe("src/dead.ts");
    expect(loc?.region).toEqual({ startLine: 1, endLine: 42 });
  });

  it("carries language, confidence, the full evidence array, and why in properties", () => {
    const c = claim({
      subject: { kind: "export", name: "a", loc: { file: "a.ts", span: [1, 1] } },
      verdict: "unused",
      confidence: "medium",
      evidence: [{ type: "static-reachability", detail: "the reason", source: "reference-graph" }],
    });
    const props = buildSarifLog(makeRun([c])).runs[0]?.results[0]?.properties;
    expect(props?.language).toBe("ts");
    expect(props?.confidence).toBe("medium");
    expect(props?.evidence).toEqual(c.evidence);
    expect(props?.why).toBe("the reason");
    expect(buildSarifLog(makeRun([c])).runs[0]?.results[0]?.message.text).toBe("the reason");
  });

  it("carries suppression provenance into properties.suppression when present, and omits the key otherwise", () => {
    const suppressed = claim({
      subject: { kind: "export", name: "a", loc: { file: "a.ts", span: [1, 1] } },
      verdict: "unused",
      suppression: {
        reason: "migration pending",
        source: "config",
        pattern: "src/legacy/**",
      },
    });
    const clean = claim({
      subject: { kind: "export", name: "b", loc: { file: "b.ts", span: [1, 1] } },
      verdict: "unused",
    });
    const results = buildSarifLog(makeRun([suppressed, clean])).runs[0]?.results ?? [];
    expect(results[0]?.properties.suppression).toEqual({
      reason: "migration pending",
      source: "config",
      pattern: "src/legacy/**",
    });
    expect(results[1]?.properties).not.toHaveProperty("suppression");
  });

  it("renderSarif prints pretty JSON with a trailing newline", () => {
    const text = renderSarif(makeRun([]));
    expect(text.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(text)).not.toThrow();
  });
});

describe("buildSarifLog — validates against the vendored SARIF 2.1.0 schema", () => {
  const validate = compileSarifSchema();

  it("an empty-results log validates", () => {
    const ok = validate(buildSarifLog(makeRun([])));
    expect(validate.errors, JSON.stringify(validate.errors)).toBeNull();
    expect(ok).toBe(true);
  });

  it("the PRD §4 worked example claim, rendered through this reporter, validates", () => {
    const c = claim({
      id: "exp_7c1a4e2f9b0d3c6a",
      subject: {
        kind: "export",
        name: "formatCurrency",
        loc: { file: "src/utils/currency.ts", span: [12, 24] },
      },
      verdict: "unused",
      confidence: "high",
      evidence: [
        {
          type: "static-reachability",
          detail:
            "0 inbound references to `formatCurrency` from any production or test entrypoint in the reference graph.",
          source: "reference-graph",
        },
      ],
    });
    const ok = validate(buildSarifLog(makeRun([c])));
    expect(validate.errors, JSON.stringify(validate.errors)).toBeNull();
    expect(ok).toBe(true);
  });

  it("a run with every subject kind + a suppression validates", () => {
    const claims: Claim[] = [
      claim({
        subject: { kind: "export", name: "a", loc: { file: "a.ts", span: [1, 2] } },
        verdict: "unused",
      }),
      claim({
        subject: { kind: "file", name: "b.ts", loc: { file: "b.ts", span: [1, 10] } },
        verdict: "unused",
      }),
      claim({
        subject: {
          kind: "dependency",
          name: "left-pad",
          loc: { file: "package.json", span: [1, 1] },
        },
        verdict: "unused",
      }),
      claim({
        subject: {
          kind: "endpoint",
          name: "GET /users",
          loc: { file: "src/routes.ts", span: [1, 3] },
          protocol: "http",
          method: "GET",
        },
        verdict: "unconsumed-endpoint",
      }),
      claim({
        subject: { kind: "test", name: "x.spec.ts", loc: { file: "x.spec.ts", span: [1, 1] } },
        verdict: "test-only",
        suppression: { reason: "flaky" },
      }),
    ];
    const ok = validate(buildSarifLog(makeRun(claims)));
    expect(validate.errors, JSON.stringify(validate.errors)).toBeNull();
    expect(ok).toBe(true);
  });
});
