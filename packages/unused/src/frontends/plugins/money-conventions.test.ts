import { describe, expect, it } from "vitest";
import {
  MONEY_AUDITED_VERSIONS,
  moneyElixirAtomRoleSummaryProvider,
  moneyElixirConventionPlugin,
} from "./money-conventions.js";

const EXPECTED_VERSIONS = [
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

describe("moneyElixirConventionPlugin", () => {
  it("owns only the audited sparse Money.new/2 result summary", async () => {
    expect(moneyElixirConventionPlugin).toMatchObject({
      id: "convention:money",
      kind: "convention",
      languages: ["ex"],
      elixirAtomRoleSummaryProvider: moneyElixirAtomRoleSummaryProvider,
    });
    expect(MONEY_AUDITED_VERSIONS).toEqual(EXPECTED_VERSIONS);
    expect(moneyElixirAtomRoleSummaryProvider).toEqual({
      id: "convention:money",
      dependency: "money",
      auditedVersions: EXPECTED_VERSIONS,
      summaries: [
        {
          module: "Money",
          name: "new",
          arity: 2,
          arguments: { 1: "propagate-to-result" },
          origin: { pluginId: "convention:money", dependency: "money" },
        },
      ],
    });
    expect(await moneyElixirConventionPlugin.applies({} as never)).toBe(false);
    expect(await moneyElixirConventionPlugin.analyze({} as never)).toEqual({});
  });

  it("excludes the materially different development release and future versions", () => {
    expect(MONEY_AUDITED_VERSIONS).toHaveLength(30);
    expect(MONEY_AUDITED_VERSIONS).not.toContain("0.0.1-dev");
    expect(MONEY_AUDITED_VERSIONS).not.toContain("1.15.1");
  });
});
