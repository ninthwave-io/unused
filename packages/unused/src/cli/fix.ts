/**
 * Conservative working-tree mutation for `unused --fix` (ADR 0012).
 *
 * The caller supplies the initial analysis claim set. This module filters that
 * frozen set to unsuppressed HIGH `unused` claims, applies only source shapes it
 * can prove safe, and never invokes Git, a package manager, or the network.
 * Re-analysis and user-facing rendering remain CLI orchestration concerns.
 */
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Claim } from "../core/claims/index.js";
import type { LocalExport } from "../frontends/ts/module-record.js";
import { parseSource } from "../frontends/ts/parse.js";

export type FixType = "exports" | "dependencies" | "files";

export interface AppliedFix {
  readonly claimId: string;
  readonly type: FixType;
  readonly file: string;
  readonly detail: string;
}

export interface SkippedFix {
  readonly claimId: string;
  readonly type: FixType;
  readonly file: string;
  readonly reason: string;
}

export interface FixResult {
  readonly eligible: number;
  readonly applied: readonly AppliedFix[];
  readonly skipped: readonly SkippedFix[];
}

export interface ApplyFixesInput {
  readonly root: string;
  readonly claims: readonly Claim[];
  readonly types: ReadonlySet<FixType>;
  readonly allowRemoveFiles: boolean;
  /** Re-export edits required by deletion plans for eligible export claims. */
  readonly requiredReExports?: readonly RequiredReExportFix[];
  /** Graph-derived fail-closed reasons captured before any mutation. */
  readonly blockedClaims?: readonly BlockedFix[];
}

export interface BlockedFix {
  readonly claimId: string;
  readonly type: FixType;
  readonly file: string;
  readonly reason: string;
}

export interface RequiredReExportFix {
  readonly claimId: string;
  readonly type: "exports" | "files";
  readonly file: string;
  readonly line: number;
  readonly exportedName?: string;
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly claimIds: readonly string[];
  readonly detail: string;
}

interface ExportListGroup {
  readonly bounds: { statementStart: number; open: number; close: number; statementEnd: number };
  readonly selections: Array<{
    readonly start: number;
    readonly end: number;
    readonly claimId: string;
  }>;
}

interface SourceEditPlan {
  readonly file: string;
  readonly path: string;
  readonly source: string;
  readonly edits: Edit[];
}

interface TransactionWrite {
  readonly file: string;
  readonly path: string;
  readonly next: string;
}

interface TransactionDelete {
  readonly file: string;
  readonly path: string;
}

interface TransactionPlan {
  readonly writes: readonly TransactionWrite[];
  readonly deletes: readonly TransactionDelete[];
  readonly applied: readonly AppliedFix[];
}

/** Apply one frozen initial claim set. The caller must re-analyse afterward. */
export async function applyFixes(input: ApplyFixesInput): Promise<FixResult> {
  const eligible = input.claims.filter((claim) => {
    const type = fixTypeOf(claim);
    return isEligible(claim) && type !== undefined && input.types.has(type);
  });
  const applied: AppliedFix[] = [];
  const skipped: SkippedFix[] = [];
  const blockedClaims = new Set<string>();
  const eligibleTypes = new Map(eligible.map((claim) => [claim.id, fixTypeOf(claim)]));
  for (const item of input.blockedClaims ?? []) {
    if (eligibleTypes.get(item.claimId) !== item.type || !input.types.has(item.type)) continue;
    blockedClaims.add(item.claimId);
    skipped.push(item);
  }
  const requirements = (input.requiredReExports ?? []).filter(
    (requirement) =>
      eligibleTypes.get(requirement.claimId) === requirement.type &&
      input.types.has(requirement.type),
  );

  const exportGroups = groupByFile(
    eligible.filter((claim) => claim.subject.kind === "export" && !blockedClaims.has(claim.id)),
  );
  for (const [file, claims] of exportGroups) {
    const planned = await planExportTransaction(
      input.root,
      file,
      claims,
      requirements.filter((item) => claims.some((claim) => claim.id === item.claimId)),
    );
    skipped.push(...planned.skipped);
    if (planned.transaction === undefined) continue;
    const failure = await commitTransaction(planned.transaction);
    if (failure !== undefined) {
      for (const claim of planned.claims) {
        skipped.push(skip(claim, "exports", `transaction failed: ${failure}`));
      }
      continue;
    }
    applied.push(...planned.transaction.applied);
  }

  const dependencyGroups = groupByFile(
    eligible.filter((claim) => claim.subject.kind === "dependency" && !blockedClaims.has(claim.id)),
  );
  for (const claims of dependencyGroups.values()) {
    const planned = await planDependencyTransaction(input.root, claims);
    if (planned.skipped !== undefined) {
      skipped.push(...planned.skipped);
      continue;
    }
    const failure = await commitTransaction(planned.transaction);
    if (failure !== undefined) {
      for (const claim of claims) {
        skipped.push(skip(claim, "dependencies", `transaction failed: ${failure}`));
      }
      continue;
    }
    applied.push(...planned.transaction.applied);
  }

  for (const claim of eligible) {
    if (claim.subject.kind !== "file") continue;
    if (blockedClaims.has(claim.id)) continue;
    if (!input.allowRemoveFiles) {
      skipped.push(skip(claim, "files", "file removal requires --allow-remove-files"));
      continue;
    }
    const planned = await planFileTransaction(
      input.root,
      claim,
      requirements.filter((item) => item.claimId === claim.id),
    );
    if (planned.skipped !== undefined) {
      skipped.push(planned.skipped);
      continue;
    }
    const failure = await commitTransaction(planned.transaction);
    if (failure !== undefined) {
      skipped.push(skip(claim, "files", `transaction failed: ${failure}`));
      continue;
    }
    applied.push(...planned.transaction.applied);
  }

  return { eligible: eligible.length, applied, skipped };
}

function isEligible(claim: Claim): boolean {
  return (
    claim.verdict === "unused" && claim.confidence === "high" && claim.suppression === undefined
  );
}

function fixTypeOf(claim: Claim): FixType | undefined {
  if (claim.subject.kind === "export") return "exports";
  if (claim.subject.kind === "dependency") return "dependencies";
  if (claim.subject.kind === "file") return "files";
  return undefined;
}

function groupByFile(claims: readonly Claim[]): Map<string, Claim[]> {
  const groups = new Map<string, Claim[]>();
  for (const claim of claims) {
    const file = claim.subject.loc.file;
    const group = groups.get(file);
    if (group === undefined) groups.set(file, [claim]);
    else group.push(claim);
  }
  return groups;
}

function groupRequiredReExports(
  requirements: readonly RequiredReExportFix[],
): Map<string, RequiredReExportFix[]> {
  const groups = new Map<string, RequiredReExportFix[]>();
  for (const requirement of requirements) {
    const group = groups.get(requirement.file);
    if (group === undefined) groups.set(requirement.file, [requirement]);
    else group.push(requirement);
  }
  return groups;
}

async function planExportTransaction(
  root: string,
  file: string,
  claims: readonly Claim[],
  requirements: readonly RequiredReExportFix[],
): Promise<{
  readonly transaction?: TransactionPlan;
  readonly claims: readonly Claim[];
  readonly skipped: readonly SkippedFix[];
}> {
  const path = await safeTarget(root, file, true);
  if (path === undefined) {
    return {
      claims: [],
      skipped: claims.map((claim) => skip(claim, "exports", "path escapes project root")),
    };
  }
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    return {
      claims: [],
      skipped: claims.map((claim) =>
        skip(claim, "exports", `cannot read source: ${errorMessage(error)}`),
      ),
    };
  }

  const primary = planExportEdits(file, source, claims);
  const primaryClaimIds = new Set(primary.edits.flatMap((edit) => edit.claimIds));
  const readyClaims = claims.filter((claim) => primaryClaimIds.has(claim.id));
  if (readyClaims.length === 0) return { claims: [], skipped: primary.skipped };

  const plans = new Map<string, SourceEditPlan>();
  plans.set(file, { file, path, source, edits: [...primary.edits] });
  const readyRequirements = requirements.filter((item) => primaryClaimIds.has(item.claimId));
  const requiredFailure = await addRequiredReExportPlans(root, readyRequirements, plans);
  if (requiredFailure !== undefined) {
    return {
      claims: readyClaims,
      skipped: [
        ...primary.skipped,
        ...readyClaims.map((claim) =>
          skip(
            claim,
            "exports",
            `required re-export preflight failed at ${requiredFailure.file}: ${requiredFailure.reason}`,
          ),
        ),
      ],
    };
  }
  const writes = finalizeSourcePlans(plans);
  if (typeof writes === "string") {
    return {
      claims: readyClaims,
      skipped: [...primary.skipped, ...readyClaims.map((claim) => skip(claim, "exports", writes))],
    };
  }

  const requiredApplied = requiredAppliedFixes(readyRequirements, plans);
  const primaryApplied = primary.edits.flatMap((edit) =>
    edit.claimIds.map((claimId) => ({
      claimId,
      type: "exports" as const,
      file,
      detail: edit.detail,
    })),
  );
  return {
    claims: readyClaims,
    skipped: primary.skipped,
    transaction: { writes, deletes: [], applied: [...requiredApplied, ...primaryApplied] },
  };
}

async function planFileTransaction(
  root: string,
  claim: Claim,
  requirements: readonly RequiredReExportFix[],
): Promise<
  | { readonly transaction: TransactionPlan; readonly skipped?: never }
  | { readonly skipped: SkippedFix }
> {
  const file = claim.subject.loc.file;
  const path = await safeTarget(root, file, false);
  if (path === undefined) return { skipped: skip(claim, "files", "path escapes project root") };
  try {
    const info = await lstat(path);
    if (!(info.isFile() || info.isSymbolicLink())) {
      return { skipped: skip(claim, "files", "target is not a removable file") };
    }
  } catch (error) {
    return { skipped: skip(claim, "files", `cannot inspect file: ${errorMessage(error)}`) };
  }

  const plans = new Map<string, SourceEditPlan>();
  const requiredFailure = await addRequiredReExportPlans(root, requirements, plans);
  if (requiredFailure !== undefined) {
    return {
      skipped: skip(
        claim,
        "files",
        `required re-export preflight failed at ${requiredFailure.file}: ${requiredFailure.reason}`,
      ),
    };
  }
  const writes = finalizeSourcePlans(plans);
  if (typeof writes === "string") return { skipped: skip(claim, "files", writes) };
  return {
    transaction: {
      writes,
      deletes: [{ file, path }],
      applied: [
        ...requiredAppliedFixes(requirements, plans),
        { claimId: claim.id, type: "files", file, detail: "removed unused file" },
      ],
    },
  };
}

async function planDependencyTransaction(
  root: string,
  claims: readonly Claim[],
): Promise<
  | { readonly transaction: TransactionPlan; readonly skipped?: never }
  | { readonly skipped: readonly SkippedFix[] }
> {
  const claim = claims[0];
  if (claim === undefined) return { skipped: [] };
  const file = claim.subject.loc.file;
  const path = await safeTarget(root, file, true);
  if (path === undefined) {
    return {
      skipped: claims.map((item) => skip(item, "dependencies", "path escapes project root")),
    };
  }
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    return {
      skipped: claims.map((item) =>
        skip(item, "dependencies", `cannot read manifest: ${errorMessage(error)}`),
      ),
    };
  }
  let next = source;
  for (const item of [...claims].sort((a, b) => b.subject.loc.span[0] - a.subject.loc.span[0])) {
    const edited = removeDependencyLine(next, item.subject.name, item.subject.loc.span[0]);
    if (edited === undefined) {
      return {
        skipped: claims.map((candidate) =>
          skip(
            candidate,
            "dependencies",
            `manifest transaction blocked because ${item.subject.name} is not in a safely editable one-property-per-line shape`,
          ),
        ),
      };
    }
    next = edited;
  }
  return {
    transaction: {
      writes: [{ file, path, next }],
      deletes: [],
      applied: claims.map((item) => ({
        claimId: item.id,
        type: "dependencies",
        file,
        detail: `removed ${item.subject.name} from manifest`,
      })),
    },
  };
}

async function addRequiredReExportPlans(
  root: string,
  requirements: readonly RequiredReExportFix[],
  plans: Map<string, SourceEditPlan>,
): Promise<{ readonly file: string; readonly reason: string } | undefined> {
  for (const [file, grouped] of groupRequiredReExports(requirements)) {
    let plan = plans.get(file);
    if (plan === undefined) {
      const path = await safeTarget(root, file, true);
      if (path === undefined) return { file, reason: "path escapes project root or is unreadable" };
      let source: string;
      try {
        source = await readFile(path, "utf8");
      } catch (error) {
        return { file, reason: `cannot read re-export source: ${errorMessage(error)}` };
      }
      plan = { file, path, source, edits: [] };
      plans.set(file, plan);
    }
    const required = planRequiredReExportEdits(file, plan.source, grouped);
    if (required.skipped.length > 0) {
      return { file, reason: required.skipped[0]?.reason ?? "required re-export is unsupported" };
    }
    plan.edits.push(...required.edits);
  }
  return undefined;
}

function finalizeSourcePlans(
  plans: ReadonlyMap<string, SourceEditPlan>,
): readonly TransactionWrite[] | string {
  const writes: TransactionWrite[] = [];
  for (const plan of plans.values()) {
    const next = applyEdits(plan.source, dedupeEdits(plan.edits));
    if (next === undefined) return `overlapping source edits in ${plan.file}`;
    if (parseSource(plan.file, next).parseErrors.length > 0) {
      return `planned rewrite does not parse cleanly in ${plan.file}`;
    }
    if (next !== plan.source) writes.push({ file: plan.file, path: plan.path, next });
  }
  return writes;
}

function requiredAppliedFixes(
  requirements: readonly RequiredReExportFix[],
  plans: ReadonlyMap<string, SourceEditPlan>,
): AppliedFix[] {
  const requirementIds = new Set(requirements.map((item) => `${item.claimId}\0${item.file}`));
  const out: AppliedFix[] = [];
  for (const plan of plans.values()) {
    for (const edit of plan.edits) {
      if (!edit.detail.startsWith("removed re-export ")) continue;
      for (const claimId of edit.claimIds) {
        if (!requirementIds.has(`${claimId}\0${plan.file}`)) continue;
        out.push({
          claimId,
          type: requirementType(requirements, claimId),
          file: plan.file,
          detail: edit.detail,
        });
      }
    }
  }
  return out;
}

interface StagedWrite extends TransactionWrite {
  readonly temp: string;
  readonly backup: string;
}

interface StagedDelete extends TransactionDelete {
  readonly backup: string;
}

/** Stage every replacement before touching an original, then rollback the whole unit on failure. */
async function commitTransaction(transaction: TransactionPlan): Promise<string | undefined> {
  const stagedWrites: StagedWrite[] = [];
  const stagedDeletes: StagedDelete[] = transaction.deletes.map((item) => ({
    ...item,
    backup: uniqueSibling(item.path, "backup"),
  }));
  try {
    for (const write of transaction.writes) {
      const info = await stat(write.path);
      if (!info.isFile()) throw new Error(`${write.file} is not a regular file`);
      const temp = uniqueSibling(write.path, "next");
      const backup = uniqueSibling(write.path, "backup");
      stagedWrites.push({ ...write, temp, backup });
      await writeFile(temp, write.next, {
        encoding: "utf8",
        flag: "wx",
        mode: info.mode & 0o7777,
      });
      await chmod(temp, info.mode & 0o7777);
    }
  } catch (error) {
    await cleanupPaths(stagedWrites.map((item) => item.temp));
    return `cannot stage edits: ${errorMessage(error)}`;
  }

  const committed: Array<
    | { readonly kind: "write"; readonly item: StagedWrite }
    | { readonly kind: "delete"; readonly item: StagedDelete }
  > = [];
  try {
    for (const item of stagedWrites) {
      await rename(item.path, item.backup);
      committed.push({ kind: "write", item });
      await rename(item.temp, item.path);
    }
    for (const item of stagedDeletes) {
      await rename(item.path, item.backup);
      committed.push({ kind: "delete", item });
    }
  } catch (error) {
    const rollbackErrors = await rollbackCommitted(committed);
    await cleanupPaths(stagedWrites.map((item) => item.temp));
    return rollbackErrors.length === 0
      ? `cannot commit edits: ${errorMessage(error)}`
      : `cannot commit edits: ${errorMessage(error)}; rollback failed: ${rollbackErrors.join("; ")}`;
  }

  await cleanupPaths([
    ...stagedWrites.map((item) => item.backup),
    ...stagedDeletes.map((item) => item.backup),
  ]);
  return undefined;
}

async function rollbackCommitted(
  committed: readonly (
    | { readonly kind: "write"; readonly item: StagedWrite }
    | { readonly kind: "delete"; readonly item: StagedDelete }
  )[],
): Promise<string[]> {
  const errors: string[] = [];
  for (const operation of [...committed].reverse()) {
    try {
      if (operation.kind === "write") {
        try {
          await unlink(operation.item.path);
        } catch (error) {
          if (!isMissingPathError(error)) throw error;
        }
        await rename(operation.item.backup, operation.item.path);
      } else {
        await rename(operation.item.backup, operation.item.path);
      }
    } catch (error) {
      errors.push(`${operation.item.file}: ${errorMessage(error)}`);
    }
  }
  return errors;
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

async function cleanupPaths(paths: readonly string[]): Promise<void> {
  await Promise.all(
    paths.map(async (path) => {
      try {
        await unlink(path);
      } catch {
        // Cleanup is best-effort after either a successful commit or rollback.
      }
    }),
  );
}

function uniqueSibling(path: string, purpose: string): string {
  return join(dirname(path), `.${basename(path)}.unused-fix-${purpose}-${randomUUID()}`);
}

async function safeTarget(
  root: string,
  file: string,
  followTarget: boolean,
): Promise<string | undefined> {
  if (isAbsolute(file)) return undefined;
  const rootAbs = await realpath(resolve(root));
  const target = resolve(rootAbs, file);
  const rel = relative(rootAbs, target);
  if (!(rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)))) return undefined;
  if (!followTarget) {
    // `unlink` does not follow a symlink in the final path component, but it
    // does traverse symlinked parent directories. Resolve and contain the
    // parent, then retain the final basename so removing an in-root symlink
    // removes the link itself without reaching an outside target.
    try {
      const parentReal = await realpath(dirname(target));
      const parentRel = relative(rootAbs, parentReal);
      if (!(parentRel === "" || (!parentRel.startsWith("..") && !isAbsolute(parentRel)))) {
        return undefined;
      }
      return resolve(parentReal, basename(target));
    } catch {
      return undefined;
    }
  }
  try {
    const targetReal = await realpath(target);
    const realRel = relative(rootAbs, targetReal);
    return realRel === "" || (!realRel.startsWith("..") && !isAbsolute(realRel))
      ? targetReal
      : undefined;
  } catch {
    return undefined;
  }
}

function planExportEdits(
  file: string,
  source: string,
  claims: readonly Claim[],
): { edits: Edit[]; skipped: SkippedFix[] } {
  const record = parseSource(file, source);
  if (record.parseErrors.length > 0) {
    return {
      edits: [],
      skipped: claims.map((claim) => skip(claim, "exports", "source has parse diagnostics")),
    };
  }
  const edits: Edit[] = [];
  const skipped: SkippedFix[] = [];
  const matched = new Set<string>();
  const listGroups = new Map<string, ExportListGroup>();

  for (const claim of claims) {
    if (claim.subject.kind !== "export") continue;
    const candidate = record.exports.find(
      (item) =>
        item.kind === "local" &&
        item.exportedName === claim.subject.name &&
        item.span.startLine === claim.subject.loc.span[0],
    );
    if (candidate === undefined || candidate.kind !== "local") {
      skipped.push(skip(claim, "exports", "export declaration could not be matched exactly"));
      continue;
    }
    matched.add(claim.id);

    if (candidate.isDefault && candidate.localName === null) {
      skipped.push(skip(claim, "exports", "anonymous default declarations are not safely fixable"));
      continue;
    }

    const list = exportListBounds(source, candidate.span.start);
    if (list !== undefined) {
      const key = `${list.statementStart}:${list.statementEnd}`;
      const group = listGroups.get(key);
      const selection = {
        start: candidate.span.start,
        end: candidate.span.end,
        claimId: claim.id,
      };
      if (group === undefined) listGroups.set(key, { bounds: list, selections: [selection] });
      else group.selections.push(selection);
      continue;
    }

    const sameDeclaration = record.exports.filter(
      (item): item is LocalExport =>
        item.kind === "local" &&
        item.span.start === candidate.span.start &&
        item.span.end === candidate.span.end,
    );
    const selectedNames = new Set(
      claims.filter((other) => other.subject.kind === "export").map((other) => other.subject.name),
    );
    if (sameDeclaration.some((item) => !selectedNames.has(item.exportedName))) {
      skipped.push(
        skip(claim, "exports", "declaration also exposes an export that is not eligible"),
      );
      continue;
    }
    const prefix = declarationExportPrefix(source, candidate.span.start, candidate.isDefault);
    if (prefix === undefined) {
      skipped.push(skip(claim, "exports", "declaration export prefix is not safely removable"));
      continue;
    }
    const claimIds = claims
      .filter(
        (other) =>
          other.subject.kind === "export" &&
          sameDeclaration.some((item) => item.exportedName === other.subject.name),
      )
      .map((other) => other.id);
    edits.push({
      start: prefix.start,
      end: prefix.end,
      text: "",
      claimIds,
      detail: candidate.isDefault ? "removed default export" : "made declaration module-private",
    });
  }

  for (const group of listGroups.values()) {
    const edit = removeListSpecifiers(source, group.selections, group.bounds);
    if (edit === undefined) {
      for (const selection of group.selections) {
        const claim = claims.find((item) => item.id === selection.claimId);
        if (claim !== undefined) {
          skipped.push(skip(claim, "exports", "export list could not be rewritten safely"));
        }
      }
      continue;
    }
    edits.push({
      ...edit,
      claimIds: [...new Set(group.selections.map((selection) => selection.claimId))],
      detail: "removed export specifier",
    });
  }

  for (const claim of claims) {
    if (!matched.has(claim.id) && !skipped.some((item) => item.claimId === claim.id)) {
      skipped.push(skip(claim, "exports", "export was not matched"));
    }
  }
  return { edits: dedupeEdits(edits), skipped };
}

function planRequiredReExportEdits(
  file: string,
  source: string,
  requirements: readonly RequiredReExportFix[],
): { edits: Edit[]; skipped: SkippedFix[] } {
  const record = parseSource(file, source);
  if (record.parseErrors.length > 0) {
    return {
      edits: [],
      skipped: requirements.map((requirement) =>
        skipRequirement(requirement, "re-export source has parse diagnostics"),
      ),
    };
  }
  const edits: Edit[] = [];
  const skipped: SkippedFix[] = [];
  const listGroups = new Map<string, ExportListGroup>();
  for (const requirement of requirements) {
    if (requirement.exportedName === undefined) {
      skipped.push(
        skipRequirement(requirement, "star re-exports cannot be narrowed safely in v0.1.0"),
      );
      continue;
    }
    const candidate = record.exports.find(
      (item) =>
        item.kind === "named-reexport" &&
        item.exportedName === requirement.exportedName &&
        item.span.startLine === requirement.line,
    );
    if (candidate === undefined || candidate.kind !== "named-reexport") {
      skipped.push(
        skipRequirement(requirement, "required named re-export was not matched exactly"),
      );
      continue;
    }
    const bounds = exportListBounds(source, candidate.span.start);
    if (bounds === undefined) {
      skipped.push(
        skipRequirement(requirement, "required re-export could not be rewritten safely"),
      );
      continue;
    }
    const key = `${bounds.statementStart}:${bounds.statementEnd}`;
    const group = listGroups.get(key);
    const selection = {
      start: candidate.span.start,
      end: candidate.span.end,
      claimId: requirement.claimId,
    };
    if (group === undefined) listGroups.set(key, { bounds, selections: [selection] });
    else group.selections.push(selection);
  }

  for (const group of listGroups.values()) {
    const edit = removeListSpecifiers(source, group.selections, group.bounds);
    if (edit === undefined) {
      for (const selection of group.selections) {
        const requirement = requirements.find((item) => item.claimId === selection.claimId);
        if (requirement !== undefined) {
          skipped.push(
            skipRequirement(requirement, "required re-export could not be rewritten safely"),
          );
        }
      }
      continue;
    }
    edits.push({
      ...edit,
      claimIds: [...new Set(group.selections.map((selection) => selection.claimId))],
      detail: "removed re-export specifier",
    });
  }
  return { edits: dedupeEdits(edits), skipped };
}

function declarationExportPrefix(
  source: string,
  declarationStart: number,
  isDefault: boolean,
): { start: number; end: number } | undefined {
  const before = source.slice(Math.max(0, declarationStart - 32), declarationStart);
  const expected = isDefault ? /export\s+default\s+$/u : /export\s+$/u;
  const match = expected.exec(before);
  if (match === null) return undefined;
  return { start: declarationStart - match[0].length, end: declarationStart };
}

function exportListBounds(
  source: string,
  position: number,
): { statementStart: number; open: number; close: number; statementEnd: number } | undefined {
  const statementStart = source.lastIndexOf("export", position);
  if (statementStart < 0) return undefined;
  const open = source.indexOf("{", statementStart);
  const close = source.indexOf("}", open + 1);
  if (open < 0 || close < 0 || !(open < position && position < close)) return undefined;
  const between = source.slice(statementStart, open);
  if (!/^export\s*$/u.test(between)) return undefined;
  const newline = source.indexOf("\n", close + 1);
  const lineEnd = newline >= 0 ? newline : source.length;
  const suffix = source.slice(close + 1, lineEnd);
  const trimmed = suffix.trim();
  let statementEnd: number;
  if (trimmed === "") statementEnd = close + 1;
  else if (/^;$/u.test(trimmed)) statementEnd = close + 1 + suffix.indexOf(";") + 1;
  else if (/^from\s+(["']).+\1\s*;?$/u.test(trimmed)) statementEnd = lineEnd;
  else return undefined;
  return { statementStart, open, close, statementEnd };
}

function removeListSpecifiers(
  source: string,
  selections: readonly { readonly start: number; readonly end: number }[],
  bounds: { statementStart: number; open: number; close: number; statementEnd: number },
): Pick<Edit, "start" | "end" | "text"> | undefined {
  const insideStart = bounds.open + 1;
  const inside = source.slice(insideStart, bounds.close);
  if (
    selections.length === 0 ||
    inside.includes("\n") ||
    inside.includes("\r") ||
    /\/[/*]|["'`]/u.test(inside)
  ) {
    return undefined;
  }

  const segments: Array<{ readonly start: number; readonly end: number }> = [];
  let segmentStart = insideStart;
  for (let offset = 0; offset <= inside.length; offset += 1) {
    if (offset !== inside.length && inside[offset] !== ",") continue;
    segments.push({ start: segmentStart, end: insideStart + offset });
    segmentStart = insideStart + offset + 1;
  }

  const removed = new Set<number>();
  for (const selection of selections) {
    const matches = segments
      .map((segment, index) => ({ segment, index }))
      .filter(({ segment }) => segment.start <= selection.start && selection.end <= segment.end);
    if (matches.length !== 1) return undefined;
    const match = matches[0];
    if (match === undefined) return undefined;
    removed.add(match.index);
  }

  const remaining = segments
    .filter((_, index) => !removed.has(index))
    .map((segment) => source.slice(segment.start, segment.end).trim())
    .filter((segment) => segment !== "");
  if (remaining.length === 0) {
    return { start: bounds.statementStart, end: bounds.statementEnd, text: "" };
  }
  return { start: insideStart, end: bounds.close, text: ` ${remaining.join(", ")} ` };
}

function dedupeEdits(edits: readonly Edit[]): Edit[] {
  const byRange = new Map<string, Edit>();
  for (const edit of edits) {
    const key = `${edit.start}:${edit.end}:${edit.text}`;
    const prior = byRange.get(key);
    byRange.set(
      key,
      prior === undefined
        ? edit
        : { ...edit, claimIds: [...new Set([...prior.claimIds, ...edit.claimIds])] },
    );
  }
  return [...byRange.values()];
}

function applyEdits(source: string, edits: readonly Edit[]): string | undefined {
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let lastStart = source.length;
  let out = source;
  for (const edit of ordered) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > lastStart) return undefined;
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    lastStart = edit.start;
  }
  return out;
}

const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function removeDependencyLine(
  source: string,
  name: string,
  expectedLine: number,
): string | undefined {
  let original: Record<string, unknown>;
  try {
    original = JSON.parse(source) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const declared = DEP_SECTIONS.some((section) => {
    const value = original[section];
    return typeof value === "object" && value !== null && Object.hasOwn(value, name);
  });
  if (!declared) return undefined;

  const escaped = escapeRegExp(name);
  const lines = source.match(/.*(?:\r?\n|$)/gu) ?? [];
  let offset = 0;
  let lineNumber = 1;
  const candidates: { start: number; end: number; comma: boolean }[] = [];
  for (const line of lines) {
    const match = new RegExp(`^\\s*"${escaped}"\\s*:\\s*.+?(,?)\\s*(?:\\r?\\n)?$`, "u").exec(line);
    if (match !== null && lineNumber === expectedLine) {
      candidates.push({ start: offset, end: offset + line.length, comma: match[1] === "," });
    }
    offset += line.length;
    lineNumber += 1;
  }
  if (candidates.length !== 1) return undefined;
  const candidate = candidates[0] as (typeof candidates)[number];
  let next = source.slice(0, candidate.start) + source.slice(candidate.end);
  if (manifestNoLongerDeclares(next, name)) return next;
  if (!candidate.comma) {
    const before = next.slice(0, candidate.start);
    const comma = before.lastIndexOf(",");
    if (comma >= 0) next = next.slice(0, comma) + next.slice(comma + 1);
  }
  return manifestNoLongerDeclares(next, name) ? next : undefined;
}

function manifestNoLongerDeclares(source: string, name: string): boolean {
  try {
    const parsed = JSON.parse(source) as Record<string, unknown>;
    return !DEP_SECTIONS.some((section) => {
      const value = parsed[section];
      return typeof value === "object" && value !== null && Object.hasOwn(value, name);
    });
  } catch {
    return false;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function skip(claim: Claim, type: FixType, reason: string): SkippedFix {
  return { claimId: claim.id, type, file: claim.subject.loc.file, reason };
}

function skipRequirement(requirement: RequiredReExportFix, reason: string): SkippedFix {
  return {
    claimId: requirement.claimId,
    type: requirement.type,
    file: requirement.file,
    reason,
  };
}

function requirementType(
  requirements: readonly RequiredReExportFix[],
  claimId: string,
): "exports" | "files" {
  return requirements.find((requirement) => requirement.claimId === claimId)?.type ?? "exports";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
