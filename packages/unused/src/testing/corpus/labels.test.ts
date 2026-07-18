import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultFixturesRoot, loadLabelCase, loadLabelCases } from "./labels.js";

// ---------------------------------------------------------------------------
// Real corpus: loads every fixtures/ts/*/labels.yaml as-is.
// ---------------------------------------------------------------------------

describe("loadLabelCases against the real corpus", () => {
  it("resolves fixtures/ts to a real directory", () => {
    // Guards the hand-counted "../../../../../fixtures/ts" relative path in
    // labels.ts against a silent layout drift (which would otherwise just
    // load zero cases rather than fail loudly).
    expect(defaultFixturesRoot()).toMatch(/\/fixtures\/ts$/);
  });

  it("loads all 15 fixture cases", async () => {
    const cases = await loadLabelCases();
    expect(cases).toHaveLength(15);
  });

  it("parses 35 subjects total across the corpus", async () => {
    const cases = await loadLabelCases();
    const total = cases.reduce((sum, c) => sum + c.subjects.length, 0);
    expect(total).toBe(35);
  });

  it("returns cases sorted by directory name", async () => {
    const cases = await loadLabelCases();
    const names = cases.map((c) => c.case);
    expect(names).toEqual([...names].sort());
  });

  it("every subject has a non-empty because", async () => {
    const cases = await loadLabelCases();
    for (const c of cases) {
      for (const subject of c.subjects) {
        expect(subject.because.length).toBeGreaterThan(0);
      }
    }
  });

  it("every dead subject carries minConfidence and every alive subject omits it", async () => {
    const cases = await loadLabelCases();
    for (const c of cases) {
      for (const subject of c.subjects) {
        if (subject.expected === "dead") {
          expect(subject.minConfidence).toBeDefined();
        } else {
          expect(subject.minConfidence).toBeUndefined();
        }
      }
    }
  });

  // Regression: `type-position-inverse` and `import-type-reexport` both use
  // a YAML block scalar (`because: >-`) specifically because their prose
  // contains a literal type annotation like `` `p: Point` `` — a `: `
  // sequence that a naive line-based "key: value" reader would mis-parse
  // (or reject) but a real YAML parser folds correctly into plain prose.
  it("preserves a literal ': ' inside a block-scalar because verbatim (type-position-inverse)", async () => {
    const cases = await loadLabelCases();
    const typePositionInverse = cases.find((c) => c.case === "type-position-inverse");
    expect(typePositionInverse).toBeDefined();
    const point = typePositionInverse?.subjects.find((s) => s.name === "Point");
    expect(point?.because).toContain("`p: Point`");
  });

  it("preserves a literal ': ' inside a block-scalar because verbatim (import-type-reexport)", async () => {
    const cases = await loadLabelCases();
    const importTypeReexport = cases.find((c) => c.case === "import-type-reexport");
    expect(importTypeReexport).toBeDefined();
    const user = importTypeReexport?.subjects.find((s) => s.name === "User");
    expect(user?.because).toContain("`u: User`");
  });
});

// ---------------------------------------------------------------------------
// Synthetic malformed labels.yaml fixtures: one temp case dir per scenario,
// asserting the loader throws a helpful, file-naming error rather than
// silently coercing or skipping bad ground truth (fixtures/README.md:
// "never edit a label to make a test pass" implies the harness must fail
// loudly on a malformed one, too).
// ---------------------------------------------------------------------------

describe("loadLabelCase / loadLabelCases on malformed labels.yaml", () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function tempCase(yamlBody: string): Promise<string> {
    root = await mkdtemp(path.join(tmpdir(), "unused-labels-test-"));
    const dir = path.join(root, "case");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "labels.yaml"), yamlBody, "utf8");
    return dir;
  }

  it("throws a helpful error when labels.yaml is missing entirely", async () => {
    root = await mkdtemp(path.join(tmpdir(), "unused-labels-test-"));
    const dir = path.join(root, "case-without-labels");
    await mkdir(dir, { recursive: true });
    await expect(loadLabelCase(dir)).rejects.toThrow(/labels\.yaml is missing or unreadable/);
  });

  it("throws on syntactically invalid YAML", async () => {
    const dir = await tempCase("case: broken\n  bad indent: [1, 2\n");
    await expect(loadLabelCase(dir)).rejects.toThrow(/not valid YAML/);
  });

  it("throws when top level is not a mapping", async () => {
    const dir = await tempCase("- just\n- a\n- list\n");
    await expect(loadLabelCase(dir)).rejects.toThrow(/top level must be a mapping/);
  });

  it("throws when 'case' is missing", async () => {
    const dir = await tempCase(
      [
        "description: test",
        "subjects:",
        "  - kind: export",
        "    name: x",
        "    file: src/x.ts",
        "    expected: alive",
        "    because: because",
      ].join("\n"),
    );
    await expect(loadLabelCase(dir)).rejects.toThrow(/field "case"/);
  });

  it("throws when 'subjects' is missing", async () => {
    const dir = await tempCase(["case: test", "description: test"].join("\n"));
    await expect(loadLabelCase(dir)).rejects.toThrow(/field "subjects"/);
  });

  it("throws when 'subjects' is an empty array", async () => {
    const dir = await tempCase(["case: test", "description: test", "subjects: []"].join("\n"));
    await expect(loadLabelCase(dir)).rejects.toThrow(/non-empty array/);
  });

  it("throws when a subject's 'kind' is not one of export|file|dependency", async () => {
    const dir = await tempCase(
      [
        "case: test",
        "description: test",
        "subjects:",
        "  - kind: endpoint",
        "    name: x",
        "    file: src/x.ts",
        "    expected: alive",
        "    because: because",
      ].join("\n"),
    );
    await expect(loadLabelCase(dir)).rejects.toThrow(/field "kind"/);
  });

  it("throws when a subject is missing 'because'", async () => {
    const dir = await tempCase(
      [
        "case: test",
        "description: test",
        "subjects:",
        "  - kind: export",
        "    name: x",
        "    file: src/x.ts",
        "    expected: alive",
      ].join("\n"),
    );
    await expect(loadLabelCase(dir)).rejects.toThrow(/field "because"/);
  });

  it("throws when expected=dead is missing minConfidence", async () => {
    const dir = await tempCase(
      [
        "case: test",
        "description: test",
        "subjects:",
        "  - kind: export",
        "    name: x",
        "    file: src/x.ts",
        "    expected: dead",
        "    because: because",
      ].join("\n"),
    );
    await expect(loadLabelCase(dir)).rejects.toThrow(/minConfidence.*is required/s);
  });

  it("throws when expected=alive carries a minConfidence", async () => {
    const dir = await tempCase(
      [
        "case: test",
        "description: test",
        "subjects:",
        "  - kind: export",
        "    name: x",
        "    file: src/x.ts",
        "    expected: alive",
        "    minConfidence: high",
        "    because: because",
      ].join("\n"),
    );
    await expect(loadLabelCase(dir)).rejects.toThrow(/must be absent when expected is "alive"/);
  });

  it("throws when minConfidence is not one of high|medium|low", async () => {
    const dir = await tempCase(
      [
        "case: test",
        "description: test",
        "subjects:",
        "  - kind: file",
        "    name: src/x.ts",
        "    file: src/x.ts",
        "    expected: dead",
        "    minConfidence: extreme",
        "    because: because",
      ].join("\n"),
    );
    await expect(loadLabelCase(dir)).rejects.toThrow(/field "minConfidence"/);
  });

  it("names the offending subject index and field in the error message", async () => {
    const dir = await tempCase(
      [
        "case: test",
        "description: test",
        "subjects:",
        "  - kind: export",
        "    name: ok",
        "    file: src/x.ts",
        "    expected: alive",
        "    because: because",
        "  - kind: export",
        "    name: bad",
        "    file: src/y.ts",
        "    expected: alive",
      ].join("\n"),
    );
    await expect(loadLabelCase(dir)).rejects.toThrow(/subjects\[1\]/);
  });

  // Regression, standalone: a block scalar containing a literal ': ' loads
  // and preserves the substring exactly, independent of the real corpus.
  it("loads a block-scalar because containing a literal ': ' correctly", async () => {
    const dir = await tempCase(
      [
        "case: test",
        "description: test",
        "subjects:",
        "  - kind: export",
        "    name: Thing",
        "    file: src/thing.ts",
        "    expected: alive",
        "    because: >-",
        "      referenced only in a type annotation (`x: Thing`) which contains",
        "      a colon-space that would confuse a naive line-based parser.",
      ].join("\n"),
    );
    const labelCase = await loadLabelCase(dir);
    expect(labelCase.subjects[0]?.because).toContain("`x: Thing`");
  });
});
