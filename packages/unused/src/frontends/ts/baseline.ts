/**
 * `.unused/baseline.jsonl` — per-workspace baseline read/write (T7.1,
 * docs/phasing.md M7; PRD §3 "Baseline workflow"; ADR 0006 version stamps).
 *
 * One file per package unit (root + every workspace member, unconditionally
 * — even a member with zero current claims gets a header-only file, so
 * `unused check` never has to guess whether an absent file means "never
 * baselined" or "baselined with nothing to bless"). Format: a header JSON
 * object on line 1 (`{analyzerVersion, idVersion, schemaVersion, configHash,
 * generatedAt}`, ADR 0006), then one `Claim` JSON object per line,
 * **id-sorted** — deterministic ordering keeps the committed diff minimal
 * across re-baselines (PRD §3).
 *
 * Every current claim is written, not just claims at/above the gate
 * threshold: the baseline is a full snapshot of "what unused currently
 * knows about this repo", and `gate.threshold` is a `unused check`-time
 * decision (PRD §6) that can change without invalidating the baseline.
 *
 * This module performs file I/O and is TS/JS-frontend-hosted (like the rest
 * of `frontends/ts`), but the format itself is entirely claim-schema-shaped
 * — a future language frontend reuses it unchanged.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Claim } from "../../core/claims/index.js";

const BASELINE_RELATIVE_PATH = ".unused/baseline.jsonl";

/** ADR 0006's baseline version stamps, plus the comparability-guard `configHash` (PRD §4). */
export interface BaselineHeader {
  readonly analyzerVersion: string;
  readonly idVersion: number;
  readonly schemaVersion: string;
  readonly configHash: string;
  /** ISO 8601 — when this baseline was written. */
  readonly generatedAt: string;
}

/** The minimal per-unit identity {@link writeBaselines}/{@link readAllBaselines} need. */
export interface BaselineUnitRef {
  /** POSIX, root-relative; `""` for the root package. */
  readonly rootRelDir: string;
  readonly name: string | null;
}

/** Absolute path to the unit's baseline file. */
export function baselineFilePath(root: string, unit: BaselineUnitRef): string {
  return unit.rootRelDir === ""
    ? join(root, BASELINE_RELATIVE_PATH)
    : join(root, unit.rootRelDir, BASELINE_RELATIVE_PATH);
}

/** The unit's baseline path, root-relative and POSIX — for display (`unused baseline`'s bless summary, `unused check`'s missing-baseline message). */
export function baselineDisplayPath(unit: BaselineUnitRef): string {
  return unit.rootRelDir === ""
    ? BASELINE_RELATIVE_PATH
    : `${unit.rootRelDir}/${BASELINE_RELATIVE_PATH}`;
}

/**
 * Partition `claims` by owning unit — the deepest `rootRelDir` prefix of
 * `subject.loc.file`, mirroring `config.ts`'s `ownerIndex` / `analyze.ts`'s
 * `annotateClaimPackages` (dependency claims' `loc.file` is the owning
 * unit's `package.json`, so this one rule covers every claim kind). The root
 * unit (`rootRelDir === ""`) is the catch-all for anything no deeper unit
 * claims.
 */
export function partitionClaimsByUnit(
  claims: readonly Claim[],
  units: readonly BaselineUnitRef[],
): ReadonlyMap<string, Claim[]> {
  const byDepth = [...units].sort((a, b) => b.rootRelDir.length - a.rootRelDir.length);
  const out = new Map<string, Claim[]>(units.map((u) => [u.rootRelDir, []]));
  for (const claim of claims) {
    const file = claim.subject.loc.file;
    const owner = byDepth.find(
      (u) => u.rootRelDir === "" || file === u.rootRelDir || file.startsWith(`${u.rootRelDir}/`),
    );
    const key = owner?.rootRelDir ?? "";
    out.get(key)?.push(claim);
  }
  return out;
}

function sortClaimsById(claims: readonly Claim[]): Claim[] {
  return [...claims].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface WrittenBaseline {
  readonly unit: BaselineUnitRef;
  readonly path: string;
  /** This unit's claims, id-sorted — exactly what was written (minus the header line). */
  readonly claims: readonly Claim[];
}

/** Write one `.unused/baseline.jsonl` per unit (root + every member, unconditionally). */
export async function writeBaselines(
  root: string,
  units: readonly BaselineUnitRef[],
  claims: readonly Claim[],
  header: BaselineHeader,
): Promise<WrittenBaseline[]> {
  const byUnit = partitionClaimsByUnit(claims, units);
  const headerLine = JSON.stringify(header);
  const out: WrittenBaseline[] = [];
  for (const unit of units) {
    const sorted = sortClaimsById(byUnit.get(unit.rootRelDir) ?? []);
    const path = baselineFilePath(root, unit);
    await mkdir(dirname(path), { recursive: true });
    const lines = [headerLine, ...sorted.map((c) => JSON.stringify(c))];
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");
    out.push({ unit, path, claims: sorted });
  }
  return out;
}

/**
 * Thrown for a baseline file that exists but cannot be parsed (empty file,
 * invalid JSON on any line, a header missing a required field). Distinct
 * from "missing" (`readBaselineFile` returns `null` for that, not a throw) —
 * a malformed baseline is a usage problem the CLI should report clearly
 * (mirroring `ConfigError`), not an analysis failure of the repo itself.
 */
export class BaselineError extends Error {
  readonly code = "BASELINE_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "BaselineError";
  }
}

export interface LoadedBaseline {
  readonly header: BaselineHeader;
  /** Not necessarily id-sorted on read (defensive — a hand-edited file is not assumed well-formed beyond parseable JSON per line). */
  readonly claims: readonly Claim[];
}

function isBaselineHeader(value: unknown): value is BaselineHeader {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["analyzerVersion"] === "string" &&
    typeof v["idVersion"] === "number" &&
    typeof v["schemaVersion"] === "string" &&
    typeof v["configHash"] === "string" &&
    typeof v["generatedAt"] === "string"
  );
}

/** `null` when the file does not exist (the "missing baseline" case, PRD §3 exit 3). Throws {@link BaselineError} on malformed content. */
export async function readBaselineFile(path: string): Promise<LoadedBaseline | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new BaselineError(
      `could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    throw new BaselineError(
      `${path} is empty (expected a header line). Fix: run \`unused baseline\` to regenerate it.`,
    );
  }

  let header: unknown;
  try {
    header = JSON.parse(lines[0] as string);
  } catch {
    throw new BaselineError(
      `${path}: line 1 is not valid JSON (expected the baseline header). Fix: run \`unused baseline\` to regenerate it.`,
    );
  }
  if (!isBaselineHeader(header)) {
    throw new BaselineError(
      `${path}: header line is missing a required field (analyzerVersion/idVersion/schemaVersion/configHash/generatedAt). Fix: run \`unused baseline\` to regenerate it.`,
    );
  }

  const claims: Claim[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    try {
      claims.push(JSON.parse(lines[i] as string) as Claim);
    } catch {
      throw new BaselineError(
        `${path}: line ${i + 1} is not valid JSON. Fix: run \`unused baseline\` to regenerate it.`,
      );
    }
  }
  return { header, claims };
}

export interface AllBaselines {
  /** Keyed by `rootRelDir`. */
  readonly byUnit: ReadonlyMap<string, LoadedBaseline>;
  /** Units with no baseline file at all — a `unused check` "run: unused baseline" condition. */
  readonly missingUnits: readonly BaselineUnitRef[];
}

/** Read every unit's baseline file, distinguishing "missing" from "loaded" per unit. Throws {@link BaselineError} on the first malformed file found. */
export async function readAllBaselines(
  root: string,
  units: readonly BaselineUnitRef[],
): Promise<AllBaselines> {
  const byUnit = new Map<string, LoadedBaseline>();
  const missingUnits: BaselineUnitRef[] = [];
  for (const unit of units) {
    const loaded = await readBaselineFile(baselineFilePath(root, unit));
    if (loaded === null) missingUnits.push(unit);
    else byUnit.set(unit.rootRelDir, loaded);
  }
  return { byUnit, missingUnits };
}
