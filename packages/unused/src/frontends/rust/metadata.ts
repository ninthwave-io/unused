/** Typed, validated subset of Cargo metadata format version 1. */

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type CargoExecutionContext,
  CargoMetadataError,
  createCargoExecutionContext,
  disposeCargoExecutionContext,
  runCargo,
  validateCargoExecutionContext,
} from "./runner.js";

export interface CargoTarget {
  readonly name: string;
  readonly kinds: readonly string[];
  readonly crateTypes: readonly string[];
  readonly srcPath: string;
  readonly edition: string;
  readonly test: boolean;
  readonly doctest: boolean;
  readonly doc: boolean;
}

export interface CargoPackage {
  readonly id: string;
  readonly name: string;
  readonly manifestPath: string;
  readonly targets: readonly CargoTarget[];
  readonly features: Readonly<Record<string, readonly string[]>>;
}

export interface CargoWorkspace {
  readonly workspaceRoot: string;
  readonly targetDirectory: string;
  readonly packages: readonly CargoPackage[];
  readonly workspaceMemberIds: ReadonlySet<string>;
}

export interface LoadCargoMetadataOptions {
  readonly cargoCommand?: string;
  /** Shared analyzer-owned execution context. Omit for a standalone metadata call. */
  readonly execution?: CargoExecutionContext;
  /** Test-only parent for a standalone metadata call's temporary target. */
  readonly targetParentDir?: string;
}

export function loadCargoMetadata(
  projectDir: string,
  options: LoadCargoMetadataOptions = {},
): CargoWorkspace {
  const root = realpathSync(resolve(projectDir));
  const ownedContext =
    options.execution === undefined
      ? createCargoExecutionContext(root, options.targetParentDir, "metadata")
      : undefined;
  const execution = options.execution ?? ownedContext;
  if (execution === undefined)
    throw new CargoMetadataError("Cargo target isolation was not created");
  let primaryFailure: unknown;
  try {
    const { targetDir } = validateCargoExecutionContext(root, execution, "metadata");
    const { stdout } = runCargo(
      root,
      ["metadata", "--frozen", "--format-version", "1", "--no-deps"],
      execution,
      options.cargoCommand,
      "metadata",
    );
    return parseCargoMetadata(stdout, root, targetDir);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    if (ownedContext !== undefined) {
      disposeCargoExecutionContext(ownedContext, primaryFailure, "metadata");
    }
  }
}

function parseCargoMetadata(stdout: string, root: string, targetDir: string): CargoWorkspace {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (error) {
    throw new CargoMetadataError("Cargo metadata returned malformed JSON", { cause: error });
  }
  const record = asRecord(raw, "metadata");
  const workspaceRoot = absolutePath(valueAt(record, "workspace_root"), "metadata.workspace_root");
  const targetDirectory = absolutePath(
    valueAt(record, "target_directory"),
    "metadata.target_directory",
  );
  if (!contains(root, workspaceRoot) && root !== workspaceRoot) {
    throw new CargoMetadataError(
      `Cargo workspace root escapes the detected boundary: ${workspaceRoot}`,
    );
  }
  if (resolve(targetDirectory) !== resolve(targetDir)) {
    throw new CargoMetadataError(
      "Cargo metadata ignored the analyzer-owned target directory; refusing to risk consumer build artifacts",
    );
  }
  const packages = asArray(valueAt(record, "packages"), "metadata.packages").map((value, index) =>
    parsePackage(value, `metadata.packages[${index}]`),
  );
  const workspaceMemberIds = new Set(
    asArray(valueAt(record, "workspace_members"), "metadata.workspace_members").map(
      (value, index) => asString(value, `metadata.workspace_members[${index}]`),
    ),
  );
  for (const memberId of workspaceMemberIds) {
    const member = packages.find((pkg) => pkg.id === memberId);
    if (member === undefined) {
      throw new CargoMetadataError(`Cargo metadata omitted workspace member ${memberId}`);
    }
    assertContained(workspaceRoot, member.manifestPath, `${member.name} manifest`);
    for (const target of member.targets) {
      assertContained(workspaceRoot, target.srcPath, `${member.name} target ${target.name}`);
    }
  }
  return {
    workspaceRoot,
    targetDirectory,
    packages,
    workspaceMemberIds,
  };
}

function parsePackage(value: unknown, field: string): CargoPackage {
  const record = asRecord(value, field);
  return {
    id: asString(valueAt(record, "id"), `${field}.id`),
    name: asString(valueAt(record, "name"), `${field}.name`),
    manifestPath: absolutePath(valueAt(record, "manifest_path"), `${field}.manifest_path`),
    targets: asArray(valueAt(record, "targets"), `${field}.targets`).map((target, index) =>
      parseTarget(target, `${field}.targets[${index}]`),
    ),
    features: parseFeatures(valueAt(record, "features"), `${field}.features`),
  };
}

function parseTarget(value: unknown, field: string): CargoTarget {
  const record = asRecord(value, field);
  return {
    name: asString(valueAt(record, "name"), `${field}.name`),
    kinds: stringArray(valueAt(record, "kind"), `${field}.kind`),
    crateTypes: stringArray(valueAt(record, "crate_types"), `${field}.crate_types`),
    srcPath: absolutePath(valueAt(record, "src_path"), `${field}.src_path`),
    edition: asString(valueAt(record, "edition"), `${field}.edition`),
    test: asBoolean(valueAt(record, "test"), `${field}.test`),
    doctest: asBoolean(valueAt(record, "doctest"), `${field}.doctest`),
    doc: asBoolean(valueAt(record, "doc"), `${field}.doc`),
  };
}

function parseFeatures(value: unknown, field: string): Readonly<Record<string, readonly string[]>> {
  const record = asRecord(value, field);
  return Object.fromEntries(
    Object.entries(record).map(([name, members]) => [
      name,
      stringArray(members, `${field}.${name}`),
    ]),
  );
}

function stringArray(value: unknown, field: string): string[] {
  return asArray(value, field).map((entry, index) => asString(entry, `${field}[${index}]`));
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CargoMetadataError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function valueAt(record: Record<string, unknown>, name: string): unknown {
  return record[name];
}

function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new CargoMetadataError(`${field} must be an array`);
  return value;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new CargoMetadataError(`${field} must be a non-empty string`);
  }
  return value;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new CargoMetadataError(`${field} must be a boolean`);
  return value;
}

function absolutePath(value: unknown, field: string): string {
  const path = asString(value, field);
  if (!isAbsolute(path)) throw new CargoMetadataError(`${field} must be absolute`);
  return resolve(path);
}

function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function assertContained(parent: string, child: string, subject: string): void {
  if (child !== parent && !contains(parent, child)) {
    throw new CargoMetadataError(`${subject} escapes the Cargo workspace root: ${child}`);
  }
}
