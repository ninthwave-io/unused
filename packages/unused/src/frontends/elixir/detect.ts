/**
 * Language detection for the Elixir frontend (ADR 0011).
 *
 * A directory is an Elixir (mix) project iff it contains a `mix.exs` at its
 * root. The CLI's language dispatch (`cli/index.ts`) uses this alongside the
 * TypeScript `package.json` check: `mix.exs` present ⇒ run the Elixir frontend;
 * both present ⇒ run both and merge claims.
 *
 * This is deliberately shallow (root-level only): `unused --cwd <dir>` points at
 * the project the user wants analyzed, so we do not walk a tree hunting for a
 * `mix.exs` (which would risk picking a dependency's or an umbrella child's
 * manifest). Umbrella support (per-`apps/*` analysis) is post-v1.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ElixirProject {
  /** Absolute path to the project directory (holds `mix.exs`). */
  readonly projectDir: string;
  /** Absolute path to the `mix.exs`. */
  readonly mixExsPath: string;
}

/** The mix project rooted at `rootDir`, or `null` when there is no `mix.exs` there. */
export function detectElixirProject(rootDir: string): ElixirProject | null {
  const mixExsPath = join(rootDir, "mix.exs");
  if (!existsSync(mixExsPath)) return null;
  return { projectDir: rootDir, mixExsPath };
}

/** `true` iff `rootDir` is an Elixir (mix) project. */
export function isElixirProject(rootDir: string): boolean {
  return existsSync(join(rootDir, "mix.exs"));
}
