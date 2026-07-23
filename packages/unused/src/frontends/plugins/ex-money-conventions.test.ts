import { describe, expect, it } from "vitest";
import {
  EX_MONEY_AUDITED_RELEASES,
  EX_MONEY_AUDITED_VERSIONS,
  exMoneyElixirAtomRoleSummaryProvider,
  exMoneyElixirConventionPlugin,
} from "./ex-money-conventions.js";

describe("exMoneyElixirConventionPlugin", () => {
  it("owns only the audited two-order Money.new/2 result summary", async () => {
    expect(EX_MONEY_AUDITED_VERSIONS).toEqual(["6.0.0-rc.0", "6.0.0", "6.1.0", "6.1.1"]);
    expect(exMoneyElixirConventionPlugin).toMatchObject({
      id: "convention:ex-money",
      kind: "convention",
      languages: ["ex"],
      elixirAtomRoleSummaryProvider: exMoneyElixirAtomRoleSummaryProvider,
    });
    expect(exMoneyElixirAtomRoleSummaryProvider).toMatchObject({
      compilerApp: "ex_money",
      otpApp: "ex_money",
      lockKey: "ex_money",
      hexPackage: "ex_money",
      repository: "hexpm",
      summaries: [
        {
          module: "Money",
          name: "new",
          arity: 2,
          arguments: { 0: "propagate-to-result", 1: "propagate-to-result" },
          origin: { pluginId: "convention:ex-money", hexPackage: "ex_money" },
        },
      ],
    });
    expect(await exMoneyElixirConventionPlugin.applies({} as never)).toBe(false);
    expect(await exMoneyElixirConventionPlugin.analyze({} as never)).toEqual({});
  });

  it("pins every audit to exact lowercase Hex checksums", () => {
    expect(EX_MONEY_AUDITED_RELEASES).toHaveLength(4);
    for (const audited of EX_MONEY_AUDITED_RELEASES) {
      expect(audited.innerChecksum).toMatch(/^[0-9a-f]{64}$/);
      expect(audited.outerChecksum).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(EX_MONEY_AUDITED_VERSIONS).not.toContain("5.19.0");
    expect(EX_MONEY_AUDITED_VERSIONS).not.toContain("6.1.2");
  });
});
