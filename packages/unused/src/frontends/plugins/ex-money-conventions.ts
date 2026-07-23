/** Publicly audited semantic summaries for the Hex `ex_money` package. */

import {
  defineElixirAtomRoleSummary,
  type ElixirAtomRoleSummaryProvider,
} from "../elixir/atom-role-summaries.js";
import type { ConventionPlugin } from "./types.js";

const exMoneyOrigin = { pluginId: "convention:ex-money", hexPackage: "ex_money" } as const;
const release = (version: string, innerChecksum: string, outerChecksum: string) => ({
  version,
  innerChecksum,
  outerChecksum,
});

/** Exact public Hex releases whose two-order Money.new/2 API was audited. */
export const EX_MONEY_AUDITED_RELEASES = [
  release(
    "6.0.0-rc.0",
    "422123e46c1aeb68582daba543b69cb32ee18e3591ce3cf9d50092384604c609",
    "ba81d5170498be2489b224493d83c81e3b9aec1a4880d25a01b0c8315aa1a32a",
  ),
  release(
    "6.0.0",
    "272b0fd95d07ebd8910f444b495f3681084ddc0956ae86fe84b417fc9af2e4b1",
    "0da160dae41dfb126151326da4e887158143b0b323692693269ca6dd5fae071d",
  ),
  release(
    "6.1.0",
    "7ed4affe61cab36df461556085d259d120ebc8a63a62b8b6628d79ce0da372a3",
    "234ef90eb72104df9a116eac75ee1798dba8af7682f26bbbb26dbf81f74ba0c4",
  ),
  release(
    "6.1.1",
    "19dbfc6457ba9205f68fe97711d8bd4e8ccac7bb3118767bf9bda71870e4d45c",
    "fec324fbc47ec7e3545091374267bfca56d32ea948cfa4d9e172ad505ff41509",
  ),
] satisfies ElixirAtomRoleSummaryProvider["auditedReleases"];

export const EX_MONEY_AUDITED_VERSIONS = EX_MONEY_AUDITED_RELEASES.map(
  (audited) => audited.version,
);

/** `ex_money` accepts amount and currency in either argument order. */
export const exMoneyElixirAtomRoleSummaryProvider: ElixirAtomRoleSummaryProvider = {
  id: "convention:ex-money",
  compilerApp: "ex_money",
  otpApp: "ex_money",
  lockKey: "ex_money",
  hexPackage: "ex_money",
  repository: "hexpm",
  auditedReleases: EX_MONEY_AUDITED_RELEASES,
  summaries: [
    defineElixirAtomRoleSummary(
      "Money",
      "new",
      2,
      { 0: "propagate-to-result", 1: "propagate-to-result" },
      { origin: exMoneyOrigin },
    ),
  ],
};

/** Registered pre-graph semantic capability with no post-graph contribution. */
export const exMoneyElixirConventionPlugin: ConventionPlugin & {
  readonly elixirAtomRoleSummaryProvider: ElixirAtomRoleSummaryProvider;
} = {
  kind: "convention",
  id: "convention:ex-money",
  version: "0.1.0",
  languages: ["ex"],
  elixirAtomRoleSummaryProvider: exMoneyElixirAtomRoleSummaryProvider,
  applies: () => false,
  async analyze() {
    return {};
  },
};
