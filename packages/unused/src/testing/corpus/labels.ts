/**
 * Loader + validator for the golden-fixture corpus's `labels.yaml` ground
 * truth (docs/adr/0009-test-strategy.md, fixtures/README.md).
 *
 * Uses a real YAML parser (`yaml`) rather than a hand-rolled line scanner:
 * several real `because:` values are YAML block scalars (`>-`) precisely
 * because their prose contains a literal `: ` (e.g. a type annotation like
 * `` `p: Point` ``) that a naive "split each line on the first colon" reader
 * would mis-parse or reject outright.
 */
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { Confidence } from "../../core/claims/types.js";

/**
 * `fixtures/README.md`: the kinds a label may judge. `test` is the M5 (T5.2)
 * zombie-test subject kind — a whole test file flagged `test-only`.
 */
export type LabelKind = "export" | "file" | "dependency" | "test";

/**
 * The expected outcome for a subject. `dead` ⇒ an `unused` claim; `test-only` ⇒
 * a `test-only` claim (the M5 tier-2 verdict — code/deps reachable only from
 * tests, and zombie test files). `alive` ⇒ no claim of any verdict.
 */
export type LabelExpected = "alive" | "dead" | "test-only";

export interface Label {
  kind: LabelKind;
  name: string;
  file: string;
  expected: LabelExpected;
  /**
   * Present (and required) on every non-`alive` subject (`dead` or `test-only`)
   * — the confidence ceiling for the expected claim (fixtures/README.md, the
   * `minConfidence` rule). Absent on `alive` subjects.
   */
  minConfidence?: Confidence;
  because: string;
}

export interface LabelCase {
  /** The `case:` field — should match the directory name. */
  case: string;
  description: string;
  subjects: readonly Label[];
  /** Absolute path to the fixture case directory (e.g. `.../fixtures/ts/basic-dead-export`). */
  dir: string;
  /** Absolute path to the `labels.yaml` this case was loaded from. */
  labelsPath: string;
}

const LABEL_KINDS: readonly LabelKind[] = ["export", "file", "dependency", "test"];
const LABEL_EXPECTED: readonly LabelExpected[] = ["alive", "dead", "test-only"];
const CONFIDENCES: readonly Confidence[] = ["high", "medium", "low"];

/**
 * Absolute path to `fixtures/ts`, the TS corpus root, computed relative to
 * this module so it resolves the same way whether run as TS source (via
 * Vitest) or as compiled JS (via `pnpm run scoreboard`, which builds to
 * `packages/unused/dist` — the same depth below the repo root as `src`).
 *
 * `.../packages/unused/src/testing/corpus/labels.ts` -> repo root is five
 * directories up (corpus, testing, src, unused, packages), then down into
 * `fixtures/ts`. Covered by a resolves-to-a-real-directory test in
 * `labels.test.ts` so a layout change fails loudly instead of silently
 * loading zero cases.
 */
export function defaultFixturesRoot(): string {
  return fileURLToPath(new URL("../../../../../fixtures/ts", import.meta.url));
}

class LabelsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LabelsError";
  }
}

function fail(context: string, detail: string, cause?: unknown): never {
  throw new LabelsError(`${context}: ${detail}`, cause === undefined ? undefined : { cause });
}

/**
 * Loosely-typed shapes for parsed-but-unvalidated YAML, used only to read
 * candidate fields off before `require*` validates them. Explicit optional
 * properties (not an index signature) so plain dot access is allowed under
 * this project's `noPropertyAccessFromIndexSignature` (tsconfig.base.json)
 * while every field is still `unknown` until validated.
 */
interface RawLabelCase {
  case?: unknown;
  description?: unknown;
  subjects?: unknown;
}

interface RawSubject {
  kind?: unknown;
  name?: unknown;
  file?: unknown;
  expected?: unknown;
  because?: unknown;
  minConfidence?: unknown;
}

function requireString(value: unknown, field: string, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(context, `field "${field}" must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  context: string,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(
      context,
      `field "${field}" must be one of ${allowed.join(" | ")}, got ${JSON.stringify(value)}`,
    );
  }
  return value as T;
}

function validateSubject(raw: unknown, index: number, context: string): Label {
  const subjectContext = `${context}, subjects[${index}]`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(subjectContext, `must be a mapping, got ${JSON.stringify(raw)}`);
  }
  const record = raw as RawSubject;

  const kind = requireEnum(record.kind, "kind", LABEL_KINDS, subjectContext);
  const name = requireString(record.name, "name", subjectContext);
  const file = requireString(record.file, "file", subjectContext);
  const expected = requireEnum(record.expected, "expected", LABEL_EXPECTED, subjectContext);
  const because = requireString(record.because, "because", subjectContext);

  const namedContext = `${subjectContext} (kind=${kind}, name=${JSON.stringify(name)})`;

  // Every non-alive expectation (`dead` ⇒ unused claim, `test-only` ⇒ test-only
  // claim) carries a confidence ceiling; `alive` never does.
  if (expected !== "alive") {
    if (record.minConfidence === undefined) {
      fail(
        namedContext,
        `field "minConfidence" is required when expected is "${expected}" (fixtures/README.md, the minConfidence rule)`,
      );
    }
    const minConfidence = requireEnum(
      record.minConfidence,
      "minConfidence",
      CONFIDENCES,
      namedContext,
    );
    return { kind, name, file, expected, because, minConfidence };
  }

  if (record.minConfidence !== undefined) {
    fail(
      namedContext,
      'field "minConfidence" must be absent when expected is "alive" — alive labels never carry a confidence ceiling (fixtures/README.md)',
    );
  }
  return { kind, name, file, expected, because };
}

function validateLabelCase(raw: unknown, labelsPath: string, dir: string): LabelCase {
  const context = labelsPath;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(context, `top level must be a mapping, got ${JSON.stringify(raw)}`);
  }
  const record = raw as RawLabelCase;

  const caseName = requireString(record.case, "case", context);
  const description = requireString(record.description, "description", context);

  const rawSubjects = record.subjects;
  if (!Array.isArray(rawSubjects) || rawSubjects.length === 0) {
    fail(context, 'field "subjects" must be a non-empty array');
  }

  const subjects = rawSubjects.map((subject, index) => validateSubject(subject, index, context));

  return { case: caseName, description, subjects, dir, labelsPath };
}

/**
 * Loads and validates a single fixture case's `labels.yaml` given its case
 * directory (e.g. `.../fixtures/ts/basic-dead-export`). Exported standalone
 * (not just as a `loadLabelCases` implementation detail) so callers that
 * already know a specific fixture directory — the scoreboard's per-case
 * analyzer run, or a test double that wants to introspect a case's ground
 * truth — don't need to re-scan the whole corpus to get one case.
 */
export async function loadLabelCase(dir: string): Promise<LabelCase> {
  const labelsPath = path.join(dir, "labels.yaml");

  let raw: string;
  try {
    raw = await readFile(labelsPath, "utf8");
  } catch (cause) {
    fail(labelsPath, "labels.yaml is missing or unreadable", cause);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (cause) {
    fail(labelsPath, `not valid YAML (${(cause as Error).message})`, cause);
  }

  return validateLabelCase(parsed, labelsPath, dir);
}

/**
 * Loads and validates every `labels.yaml` directly under `fixturesRoot`
 * (one level, matching `fixtures/<language>/<case>/labels.yaml`). Throws a
 * `LabelsError` naming the offending file and field on any malformed label —
 * per `fixtures/README.md`, labels are ground truth and a malformed one is a
 * data bug to fix, never silently skipped or coerced.
 *
 * Results are sorted by case directory name for a deterministic order,
 * which the scoreboard and gate tests rely on.
 */
export async function loadLabelCases(
  fixturesRoot: string = defaultFixturesRoot(),
): Promise<LabelCase[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(fixturesRoot, { withFileTypes: true });
  } catch (cause) {
    fail(fixturesRoot, "could not read the fixtures root directory", cause);
  }

  const caseDirNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const cases: LabelCase[] = [];
  for (const dirName of caseDirNames) {
    cases.push(await loadLabelCase(path.join(fixturesRoot, dirName)));
  }

  return cases;
}
