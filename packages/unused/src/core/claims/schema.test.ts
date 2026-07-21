/**
 * Validates `schema/claim-run.schema.json` against ajv (draft 2020-12):
 * (1) the current PRD §4 worked example, copied verbatim into
 *     `fixtures/prd-worked-example.json`, must validate unchanged; and
 * (2) the schema's oneOf-per-kind encoding of the kind -> verdict binding
 *     (PRD §4) rejects mismatched pairings, mirroring `isValidKindVerdict`
 *     in `types.ts` at the JSON Schema layer.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
// Named import sidesteps a default-export type-resolution quirk under this
// repo's ESM + NodeNext + verbatimModuleSyntax tsconfig: ajv ships as CJS
// with no package.json "exports" map, so `import Ajv2020 from ".../2020.js"`
// types as the whole module namespace (uncallable) instead of the class ajv
// actually exports as `module.exports`/`.default` at runtime. The named
// `Ajv2020` class export doesn't have that ambiguity.
import { Ajv2020 } from "ajv/dist/2020.js";
// Same quirk, but ajv-formats has no named alternative to its default
// export. `require` it directly (its CJS `module.exports` *is* the plugin
// function — confirmed by reading dist/index.js) and type the result via a
// type-only import, which never goes through the broken default-export
// value resolution above.
import type { FormatsPlugin } from "ajv-formats";
import { describe, expect, it } from "vitest";

const addFormats = createRequire(import.meta.url)("ajv-formats") as FormatsPlugin;

function readJson(relativePath: string): unknown {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

const schema = readJson("./schema/claim-run.schema.json");
const prdWorkedExample = readJson("./fixtures/prd-worked-example.json");

function compileSchema() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema as object);
}

describe("claim-run.schema.json", () => {
  it("is itself a valid draft 2020-12 schema (compiles under strict mode)", () => {
    expect(() => compileSchema()).not.toThrow();
  });

  it("validates the PRD §4 worked example verbatim", () => {
    const validate = compileSchema();
    const valid = validate(prdWorkedExample);
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("requires analyzed boundaries and explicit claim language attribution", () => {
    const validate = compileSchema();
    const withoutBoundaries = structuredClone(prdWorkedExample) as {
      run: { boundaries?: unknown };
    };
    delete withoutBoundaries.run.boundaries;
    expect(validate(withoutBoundaries)).toBe(false);

    const withoutLanguage = structuredClone(prdWorkedExample) as {
      claims: [{ language?: string }];
    };
    delete withoutLanguage.claims[0].language;
    expect(validate(withoutLanguage)).toBe(false);
  });

  it("accepts an explicitly partial test partition and rejects status/completeness drift", () => {
    const validate = compileSchema();
    const partial = structuredClone(prdWorkedExample) as {
      run: {
        boundaries: Array<{
          status: string;
          partitions: { production: string; config: string; test: string };
        }>;
      };
    };
    const boundary = partial.run.boundaries[0];
    if (boundary === undefined) throw new Error("worked example boundary missing");
    boundary.status = "partial";
    boundary.partitions.test = "incomplete";
    expect(validate(partial), JSON.stringify(validate.errors)).toBe(true);

    boundary.status = "complete";
    expect(validate(partial)).toBe(false);
    boundary.partitions.test = "complete";
    boundary.status = "partial";
    expect(validate(partial)).toBe(false);
  });

  it("rejects a claim pairing subject.kind=export with verdict=unconsumed-endpoint", () => {
    const validate = compileSchema();
    // A single-element tuple (not Array<T>) keeps `claims[0]` indexing
    // sound under noUncheckedIndexedAccess without a non-null assertion —
    // the PRD worked example fixture always has exactly one claim.
    const mutated = structuredClone(prdWorkedExample) as {
      claims: [{ verdict: string }];
    };
    const [claim] = mutated.claims;
    claim.verdict = "unconsumed-endpoint";
    expect(validate(mutated)).toBe(false);
  });

  it("rejects a claim pairing subject.kind=endpoint with verdict=unused", () => {
    const validate = compileSchema();
    const endpointClaimWrongVerdict = {
      schemaVersion: "1.0.0",
      tool: { name: "unused", version: "0.1.0" },
      run: {
        root: "/repo",
        configHash: "abc123",
        startedAt: "2026-07-18T09:12:03.000Z",
        durationMs: 10,
      },
      claims: [
        {
          id: "end_0123456789abcdef",
          subject: {
            kind: "endpoint",
            name: "/users",
            loc: { file: "src/pages/api/users.ts", span: [1, 10] },
            protocol: "http",
            method: "GET",
          },
          // Invalid: endpoint subjects always take unconsumed-endpoint (PRD §4).
          verdict: "unused",
          confidence: "high",
          evidence: [
            { type: "static-reachability", detail: "no consumers", source: "reference-graph" },
          ],
          provenance: {
            analyzer: "ts-reference-graph",
            version: "0.1.0",
            generatedAt: "2026-07-18T09:12:07.210Z",
          },
        },
      ],
      summary: {
        byKind: { export: 0, file: 0, dependency: 0, endpoint: 1, test: 0 },
        byConfidence: { high: 1, medium: 0, low: 0 },
        estDeletableLoc: 10,
      },
    };
    expect(validate(endpointClaimWrongVerdict)).toBe(false);
  });

  it("rejects an unknown top-level property (additionalProperties: false)", () => {
    const validate = compileSchema();
    const mutated = { ...(prdWorkedExample as object), extra: "nope" };
    expect(validate(mutated)).toBe(false);
  });

  it("rejects a claim id that doesn't match the ADR 0006 <prefix>_<16 hex> shape", () => {
    const validate = compileSchema();
    const mutated = structuredClone(prdWorkedExample) as { claims: [{ id: string }] };
    const [claim] = mutated.claims;
    claim.id = "not-a-valid-id";
    expect(validate(mutated)).toBe(false);
  });

  it("accepts an open (non-reserved) evidence[].type value, per the ADR 0006 open-enum policy", () => {
    const validate = compileSchema();
    const mutated = structuredClone(prdWorkedExample) as {
      claims: [{ evidence: [{ type: string }] }];
    };
    const [claim] = mutated.claims;
    const [evidence] = claim.evidence;
    evidence.type = "some-future-evidence-type";
    expect(validate(mutated)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// summary.zombieTests (T5.3, 1.1.0 additive field — ADR 0006 MINOR bump)
// ---------------------------------------------------------------------------

describe("claim-run.schema.json — summary.zombieTests", () => {
  it("validates without a zombieTests block (absent = zero-zombie run, PRD worked example)", () => {
    const validate = compileSchema();
    // The PRD worked example's single claim is a plain export, no zombie
    // tests — `summary` already omits `zombieTests` and still validates
    // (covered by the "validates the PRD §4 worked example verbatim" test
    // above too; this test names the invariant explicitly).
    expect(validate(prdWorkedExample)).toBe(true);
  });

  it("validates a well-formed zombieTests block", () => {
    const validate = compileSchema();
    const mutated = structuredClone(prdWorkedExample) as {
      summary: { zombieTests?: unknown };
    };
    mutated.summary.zombieTests = {
      count: 3,
      estCiSecondsPerRun: 15,
      estimated: true,
      avgSecondsPerTestFile: 5,
    };
    expect(validate(mutated), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects estimated: false — the field is a literal true, never a real measurement flag", () => {
    const validate = compileSchema();
    const mutated = structuredClone(prdWorkedExample) as {
      summary: { zombieTests?: unknown };
    };
    mutated.summary.zombieTests = {
      count: 1,
      estCiSecondsPerRun: 5,
      estimated: false,
      avgSecondsPerTestFile: 5,
    };
    expect(validate(mutated)).toBe(false);
  });

  it("rejects count: 0 — a zero-zombie run must omit the block entirely, never report a zero", () => {
    const validate = compileSchema();
    const mutated = structuredClone(prdWorkedExample) as {
      summary: { zombieTests?: unknown };
    };
    mutated.summary.zombieTests = {
      count: 0,
      estCiSecondsPerRun: 0,
      estimated: true,
      avgSecondsPerTestFile: 5,
    };
    expect(validate(mutated)).toBe(false);
  });

  it("rejects a zombieTests block missing a required field", () => {
    const validate = compileSchema();
    const mutated = structuredClone(prdWorkedExample) as {
      summary: { zombieTests?: unknown };
    };
    mutated.summary.zombieTests = { count: 1, estCiSecondsPerRun: 5, estimated: true };
    expect(validate(mutated)).toBe(false);
  });

  it("rejects an unknown property inside zombieTests (additionalProperties: false)", () => {
    const validate = compileSchema();
    const mutated = structuredClone(prdWorkedExample) as {
      summary: { zombieTests?: unknown };
    };
    mutated.summary.zombieTests = {
      count: 1,
      estCiSecondsPerRun: 5,
      estimated: true,
      avgSecondsPerTestFile: 5,
      extra: "nope",
    };
    expect(validate(mutated)).toBe(false);
  });
});
