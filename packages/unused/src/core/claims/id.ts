/**
 * Claim identity — ADR 0006 exactly.
 *
 * id = "<prefix>_<first 16 hex of SHA-256(canonical)>"
 * canonical = "<idVersion>\0<kind>\0<language>\0<name>\0<file>\0<protocol>\0<method>"
 *
 * - Absent fields (`language`, `protocol`, `method`) serialise as `""`.
 * - `file` must be POSIX-style and repo-relative; this module defensively
 *   collapses `\` separators so a Windows-produced path still hashes
 *   identically to its POSIX form, but callers own making it repo-relative.
 * - `language` empty implies `ts` in v1 (ADR 0006) — the slot exists so a
 *   future Python/Elixir frontend's claims never collide with TS ones.
 * - `span` is deliberately excluded: ids are stable to any edit that keeps
 *   the subject's kind, name, and file — including moving it within the
 *   file — but change on rename or cross-file move (PRD §4, documented
 *   behaviour, not a bug).
 * - For `endpoint` subjects, `protocol` and (for HTTP) `method` are part of
 *   identity: `GET /users` and `POST /users` are distinct claims (PRD §4).
 */
import { createHash } from "node:crypto";
import type { Subject, SubjectKind } from "./types.js";

/** Bumped only when this id recipe changes (ADR 0006). */
export const ID_VERSION = 1;

/** Claim id prefix by subject kind (ADR 0006). */
export const CLAIM_ID_PREFIX: Readonly<Record<SubjectKind, string>> = {
  export: "exp",
  file: "fil",
  dependency: "dep",
  endpoint: "end",
  test: "tst",
};

export interface ClaimIdOptions {
  /** Empty/absent implies `ts` in v1 (ADR 0006). */
  language?: string;
}

function toPosixRelative(file: string): string {
  return file.replace(/\\/g, "/");
}

function protocolOf(subject: Subject): string {
  return subject.kind === "endpoint" ? subject.protocol : "";
}

function methodOf(subject: Subject): string {
  return subject.kind === "endpoint" ? (subject.method ?? "") : "";
}

/** Builds the ADR 0006 canonical subject string (exported for tests/debugging, not part of the id). */
export function canonicalSubjectString(subject: Subject, options: ClaimIdOptions = {}): string {
  return [
    String(ID_VERSION),
    subject.kind,
    options.language ?? "",
    subject.name,
    toPosixRelative(subject.loc.file),
    protocolOf(subject),
    methodOf(subject),
  ].join("\0");
}

/** Computes the stable claim id for a subject per ADR 0006. */
export function computeClaimId(subject: Subject, options: ClaimIdOptions = {}): string {
  const canonical = canonicalSubjectString(subject, options);
  const hash = createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
  return `${CLAIM_ID_PREFIX[subject.kind]}_${hash}`;
}
