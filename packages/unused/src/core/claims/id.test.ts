import { describe, expect, it } from "vitest";
import { CLAIM_ID_PREFIX, computeClaimId, ID_VERSION } from "./id.js";
import type { EndpointSubject, ExportSubject } from "./types.js";

function exportSubject(overrides: Partial<ExportSubject> = {}): ExportSubject {
  return {
    kind: "export",
    name: "formatCurrency",
    loc: { file: "src/utils/currency.ts", span: [12, 24] },
    ...overrides,
  };
}

function endpointSubject(overrides: Partial<EndpointSubject> = {}): EndpointSubject {
  return {
    kind: "endpoint",
    name: "/users",
    loc: { file: "src/pages/api/users.ts", span: [1, 40] },
    protocol: "http",
    ...overrides,
  };
}

describe("computeClaimId", () => {
  it("exports the ADR 0006 id version", () => {
    expect(ID_VERSION).toBe(1);
  });

  it("prefixes ids by subject kind", () => {
    expect(CLAIM_ID_PREFIX).toEqual({
      export: "exp",
      file: "fil",
      dependency: "dep",
      endpoint: "end",
      test: "tst",
    });
  });

  it("produces the exp_<16 hex> shape", () => {
    const id = computeClaimId(exportSubject());
    expect(id).toMatch(/^exp_[0-9a-f]{16}$/);
  });

  it("is stable: the same subject produces the same id", () => {
    const a = computeClaimId(exportSubject());
    const b = computeClaimId(exportSubject());
    expect(a).toBe(b);
  });

  it("changes when the name changes", () => {
    const original = computeClaimId(exportSubject());
    const renamed = computeClaimId(exportSubject({ name: "formatMoney" }));
    expect(renamed).not.toBe(original);
  });

  it("changes when the file moves", () => {
    const original = computeClaimId(exportSubject());
    const moved = computeClaimId(
      exportSubject({ loc: { file: "src/lib/currency.ts", span: [12, 24] } }),
    );
    expect(moved).not.toBe(original);
  });

  it("is unchanged by a span-only move within the same file", () => {
    const original = computeClaimId(exportSubject());
    const movedWithinFile = computeClaimId(
      exportSubject({ loc: { file: "src/utils/currency.ts", span: [40, 52] } }),
    );
    expect(movedWithinFile).toBe(original);
  });

  it("distinguishes endpoint claims by HTTP method (GET vs POST)", () => {
    const getId = computeClaimId(endpointSubject({ method: "GET" }));
    const postId = computeClaimId(endpointSubject({ method: "POST" }));
    expect(getId).not.toBe(postId);
    expect(getId).toMatch(/^end_[0-9a-f]{16}$/);
    expect(postId).toMatch(/^end_[0-9a-f]{16}$/);
  });

  it("treats a method-less endpoint as distinct from either method (empty method slot)", () => {
    const noMethodId = computeClaimId(endpointSubject());
    const getId = computeClaimId(endpointSubject({ method: "GET" }));
    expect(noMethodId).not.toBe(getId);
  });

  it("does not conflate kinds sharing a name/file (prefix disambiguates)", () => {
    const exportId = computeClaimId(
      exportSubject({ name: "utils", loc: { file: "src/utils.ts", span: [1, 1] } }),
    );
    const fileId = computeClaimId({
      kind: "file",
      name: "utils",
      loc: { file: "src/utils.ts", span: [1, 1] },
    });
    expect(exportId).not.toBe(fileId);
  });

  it("changes when language differs (v1 leaves it empty, implying ts)", () => {
    const tsImplied = computeClaimId(exportSubject());
    const pythonTagged = computeClaimId(exportSubject(), { language: "py" });
    expect(tsImplied).not.toBe(pythonTagged);
  });
});
