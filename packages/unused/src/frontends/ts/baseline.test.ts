import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeClaimId } from "../../core/claims/id.js";
import type { Claim, ExportClaim } from "../../core/claims/types.js";
import {
  BaselineError,
  type BaselineHeader,
  type BaselineUnitRef,
  baselineDisplayPath,
  baselineFilePath,
  partitionClaimsByUnit,
  readAllBaselines,
  readBaselineFile,
  writeBaselines,
} from "./baseline.js";

const PROVENANCE = {
  analyzer: "ts-reference-graph",
  version: "0.1.0",
  generatedAt: "2026-07-18T09:12:07.210Z",
} as const;

function exportClaim(
  name: string,
  file: string,
  overrides: Partial<ExportClaim> = {},
): ExportClaim {
  const subject = { kind: "export" as const, name, loc: { file, span: [1, 2] as const } };
  return {
    id: computeClaimId(subject),
    language: "ts",
    subject,
    verdict: "unused",
    confidence: "high",
    evidence: [
      { type: "static-reachability", detail: "no inbound refs", source: "reference-graph" },
    ],
    provenance: PROVENANCE,
    ...overrides,
  };
}

const HEADER: BaselineHeader = {
  analyzerVersion: "0.1.0",
  idVersion: 1,
  schemaVersion: "1.1.0",
  configHash: "abc123",
  generatedAt: "2026-07-18T09:12:03.000Z",
};

describe("baselineFilePath / baselineDisplayPath", () => {
  it("root unit -> <root>/.unused/baseline.jsonl", () => {
    expect(baselineFilePath("/repo", { rootRelDir: "", name: null })).toBe(
      "/repo/.unused/baseline.jsonl",
    );
    expect(baselineDisplayPath({ rootRelDir: "", name: null })).toBe(".unused/baseline.jsonl");
  });

  it("a member unit -> <root>/<rootRelDir>/.unused/baseline.jsonl", () => {
    expect(baselineFilePath("/repo", { rootRelDir: "packages/app", name: "@x/app" })).toBe(
      "/repo/packages/app/.unused/baseline.jsonl",
    );
    expect(baselineDisplayPath({ rootRelDir: "packages/app", name: "@x/app" })).toBe(
      "packages/app/.unused/baseline.jsonl",
    );
  });
});

describe("partitionClaimsByUnit", () => {
  const units: BaselineUnitRef[] = [
    { rootRelDir: "", name: null },
    { rootRelDir: "packages/app", name: "@x/app" },
    { rootRelDir: "packages/app-extra", name: "@x/app-extra" },
  ];

  it("assigns each claim to its deepest-matching rootRelDir prefix, root as catch-all", () => {
    const rootClaim = exportClaim("rootOnly", "scripts/build.ts");
    const appClaim = exportClaim("appThing", "packages/app/src/x.ts");
    const appExtraClaim = exportClaim("extraThing", "packages/app-extra/src/y.ts");
    const byUnit = partitionClaimsByUnit([rootClaim, appClaim, appExtraClaim], units);

    expect(byUnit.get("")?.map((c) => c.id)).toEqual([rootClaim.id]);
    expect(byUnit.get("packages/app")?.map((c) => c.id)).toEqual([appClaim.id]);
    expect(byUnit.get("packages/app-extra")?.map((c) => c.id)).toEqual([appExtraClaim.id]);
  });

  it("does not let a shorter prefix swallow a longer sibling directory (packages/app vs packages/app-extra)", () => {
    const appExtraClaim = exportClaim("extraThing", "packages/app-extra/src/y.ts");
    const byUnit = partitionClaimsByUnit([appExtraClaim], units);
    expect(byUnit.get("packages/app")).toEqual([]);
    expect(byUnit.get("packages/app-extra")).toEqual([appExtraClaim]);
  });

  it("every unit is present in the map even with zero claims (so a header-only file is always written)", () => {
    const byUnit = partitionClaimsByUnit([], units);
    for (const unit of units) expect(byUnit.get(unit.rootRelDir)).toEqual([]);
  });
});

describe("writeBaselines / readBaselineFile / readAllBaselines", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "unused-baseline-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const units: BaselineUnitRef[] = [
    { rootRelDir: "", name: "root-pkg" },
    { rootRelDir: "packages/app", name: "@x/app" },
  ];

  it("writes one file per unit, unconditionally (header-only when a unit has no claims)", async () => {
    const rootClaim = exportClaim("rootThing", "src/x.ts");
    await writeBaselines(dir, units, [rootClaim], HEADER);

    const rootRaw = await readFile(baselineFilePath(dir, units[0] as BaselineUnitRef), "utf8");
    const appRaw = await readFile(baselineFilePath(dir, units[1] as BaselineUnitRef), "utf8");
    expect(rootRaw.trim().split("\n")).toHaveLength(2); // header + 1 claim
    expect(appRaw.trim().split("\n")).toHaveLength(1); // header only
  });

  it("round-trips through readBaselineFile: header + claims match what was written", async () => {
    const claim = exportClaim("thing", "src/x.ts");
    await writeBaselines(dir, units, [claim], HEADER);
    const loaded = await readBaselineFile(baselineFilePath(dir, units[0] as BaselineUnitRef));
    expect(loaded?.header).toEqual(HEADER);
    expect(loaded?.claims.map((c) => c.id)).toEqual([claim.id]);
  });

  it("claim lines are id-sorted regardless of input order (minimal-diff-churn contract)", async () => {
    const claims: Claim[] = [
      exportClaim("z", "src/z.ts"),
      exportClaim("a", "src/a.ts"),
      exportClaim("m", "src/m.ts"),
    ];
    await writeBaselines(dir, units, claims, HEADER);
    const loaded = await readBaselineFile(baselineFilePath(dir, units[0] as BaselineUnitRef));
    const ids = loaded?.claims.map((c) => c.id) ?? [];
    expect(ids).toEqual([...ids].sort());
  });

  it("is deterministic: writing the same claims + header twice produces byte-identical files", async () => {
    const claims: Claim[] = [exportClaim("b", "src/b.ts"), exportClaim("a", "src/a.ts")];
    await writeBaselines(dir, units, claims, HEADER);
    const first = await readFile(baselineFilePath(dir, units[0] as BaselineUnitRef), "utf8");
    await writeBaselines(dir, units, claims, HEADER);
    const second = await readFile(baselineFilePath(dir, units[0] as BaselineUnitRef), "utf8");
    expect(second).toBe(first);
  });

  it("readBaselineFile returns null for a missing file (not a throw)", async () => {
    const loaded = await readBaselineFile(join(dir, "does-not-exist", "baseline.jsonl"));
    expect(loaded).toBeNull();
  });

  it("readAllBaselines reports missingUnits for any unit with no file", async () => {
    await writeBaselines(dir, [units[0] as BaselineUnitRef], [], HEADER); // only the root unit
    const all = await readAllBaselines(dir, units);
    expect(all.missingUnits).toEqual([units[1]]);
    expect(all.byUnit.has("")).toBe(true);
  });

  it("throws BaselineError on an empty file", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const path = baselineFilePath(dir, units[0] as BaselineUnitRef);
    await mkdir(join(dir, ".unused"), { recursive: true });
    await writeFile(path, "", "utf8");
    await expect(readBaselineFile(path)).rejects.toThrow(BaselineError);
  });

  it("throws BaselineError on an unparseable header line", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const path = baselineFilePath(dir, units[0] as BaselineUnitRef);
    await mkdir(join(dir, ".unused"), { recursive: true });
    await writeFile(path, "not json\n", "utf8");
    await expect(readBaselineFile(path)).rejects.toThrow(BaselineError);
  });

  it("throws BaselineError when the header is missing a required field", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const path = baselineFilePath(dir, units[0] as BaselineUnitRef);
    await mkdir(join(dir, ".unused"), { recursive: true });
    await writeFile(path, `${JSON.stringify({ analyzerVersion: "0.1.0" })}\n`, "utf8");
    await expect(readBaselineFile(path)).rejects.toThrow(BaselineError);
  });

  it("throws BaselineError on an unparseable claim line", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const path = baselineFilePath(dir, units[0] as BaselineUnitRef);
    await mkdir(join(dir, ".unused"), { recursive: true });
    await writeFile(path, `${JSON.stringify(HEADER)}\nnot json\n`, "utf8");
    await expect(readBaselineFile(path)).rejects.toThrow(BaselineError);
  });
});
