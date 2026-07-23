/** Deterministic pre-graph Elixir semantic-provider inventory. */

import {
  type ElixirAtomRoleSummaryProvider,
  validateElixirAtomRoleSummaryProviders,
} from "../elixir/atom-role-summaries.js";
import type { ConventionPlugin } from "./types.js";

/**
 * Collect static semantic providers before any language boundary is analyzed.
 * Post-graph convention applicability is deliberately unrelated to this phase.
 */
export function collectElixirAtomRoleSummaryProviders(
  plugins: readonly ConventionPlugin[],
): readonly ElixirAtomRoleSummaryProvider[] {
  const providers: ElixirAtomRoleSummaryProvider[] = [];
  for (const plugin of [...plugins].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  )) {
    const provider = plugin.elixirAtomRoleSummaryProvider;
    if (provider === undefined) continue;
    if (!plugin.languages.includes("ex")) {
      throw new Error(`Elixir atom role summary provider ${plugin.id} is not an Elixir convention`);
    }
    if (provider.id !== plugin.id) {
      throw new Error(`Elixir atom role summary provider id does not match plugin ${plugin.id}`);
    }
    providers.push(provider);
  }
  validateElixirAtomRoleSummaryProviders(providers);
  return Object.freeze(providers);
}
