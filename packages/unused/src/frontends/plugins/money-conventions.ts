/** Publicly audited semantic summaries for the Hex `money` package. */

import {
  defineElixirAtomRoleSummary,
  type ElixirAtomRoleSummaryProvider,
} from "../elixir/atom-role-summaries.js";
import type { ConventionPlugin } from "./types.js";

const moneyOrigin = { pluginId: "convention:money", dependency: "money" } as const;

/** Exact published Hex releases whose Money.new/2 result flow was audited. */
export const MONEY_AUDITED_VERSIONS = [
  "1.0.0-beta",
  "1.0.0",
  "1.1.0",
  "1.1.1",
  "1.1.2",
  "1.1.3",
  "1.2.0",
  "1.2.1",
  "1.3.0",
  "1.3.1",
  "1.3.2",
  "1.4.0",
  "1.5.0",
  "1.5.1",
  "1.6.0",
  "1.6.1",
  "1.7.0",
  "1.8.0",
  "1.9.0",
  "1.10.0",
  "1.11.0",
  "1.12.0",
  "1.12.1",
  "1.12.2",
  "1.12.3",
  "1.12.4",
  "1.13.0",
  "1.13.1",
  "1.14.0",
  "1.15.0",
] as const;

/** Semantic summaries owned by the provider-only Money convention plugin. */
export const moneyElixirAtomRoleSummaryProvider: ElixirAtomRoleSummaryProvider = {
  id: "convention:money",
  dependency: "money",
  auditedVersions: MONEY_AUDITED_VERSIONS,
  summaries: [
    defineElixirAtomRoleSummary(
      "Money",
      "new",
      2,
      { 1: "propagate-to-result" },
      { origin: moneyOrigin },
    ),
  ],
};

/** Registered pre-graph semantic capability with no post-graph contribution. */
export const moneyElixirConventionPlugin: ConventionPlugin & {
  readonly elixirAtomRoleSummaryProvider: ElixirAtomRoleSummaryProvider;
} = {
  kind: "convention",
  id: "convention:money",
  version: "0.1.0",
  languages: ["ex"],
  elixirAtomRoleSummaryProvider: moneyElixirAtomRoleSummaryProvider,
  applies: () => false,
  async analyze() {
    return {};
  },
};
