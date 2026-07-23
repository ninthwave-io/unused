import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ECTO_ADD_ERROR_AUDITED_VERSIONS,
  ectoElixirAtomRoleSummaryProvider,
} from "../plugins/elixir-conventions.js";
import {
  EX_MONEY_AUDITED_VERSIONS,
  exMoneyElixirAtomRoleSummaryProvider,
} from "../plugins/ex-money-conventions.js";
import {
  MONEY_AUDITED_VERSIONS,
  moneyElixirAtomRoleSummaryProvider,
} from "../plugins/money-conventions.js";
import type { ElixirAtomRoleSummaryProvider } from "./atom-role-summaries.js";
import type { HexDependencyApplication, ModuleRecord, TraceEvent, TraceResult } from "./events.js";
import { extractElixirRuntimeConventions } from "./runtime-references.js";

const providers: readonly ElixirAtomRoleSummaryProvider[] = [
  ectoElixirAtomRoleSummaryProvider,
  exMoneyElixirAtomRoleSummaryProvider,
  moneyElixirAtomRoleSummaryProvider,
];

describe("audited dependency constructor-result summaries", () => {
  it("propagates exact result values, retains unknown sinks, and omits impossible roles", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-constructor-results-"));
    const file = "constructor_results.ex";
    const lines = [
      "defmodule NeutralConstructors.Flow do",
      "  def money_data(raw), do: Money.new(100, String.to_atom(raw)) |> Map.fetch!(:currency) |> Atom.to_string()",
      "  def money_escape(raw), do: Money.new(100, String.to_atom(raw)) |> NeutralConstructors.External.keep()",
      "  def money_sparse(raw), do: Money.new(String.to_atom(raw), :USD)",
      "  def money_duplicate(raw), do: Money.new(100, String.to_atom(raw)) |> Map.fetch!(:currency) |> Atom.to_string()",
      "  def money_ambiguous(raw) do",
      "    currency = String.to_atom(raw)",
      "    {Money.new(100, currency), Money.new(200, currency)}",
      "  end",
      '  def ecto_three_data(changeset, raw), do: Ecto.Changeset.add_error(changeset, String.to_atom(raw), "invalid") |> Map.has_key?(:errors)',
      '  def ecto_three_escape(changeset, raw), do: Ecto.Changeset.add_error(changeset, String.to_atom(raw), "invalid") |> NeutralConstructors.External.keep()',
      '  def ecto_four_escape(changeset, raw), do: Ecto.Changeset.add_error(changeset, :field, "invalid", source: String.to_atom(raw)) |> NeutralConstructors.External.keep()',
      "  def ecto_message_sparse(changeset, raw), do: Ecto.Changeset.add_error(changeset, :field, String.to_atom(raw))",
      "end",
    ];
    const lineOf = (needle: string): number => lines.findIndex((line) => line.includes(needle)) + 1;
    const event = (
      fromFun: string,
      needle: string,
      toMod: string,
      name: string,
      arity: number,
      dyn = false,
    ): TraceEvent => ({
      k: "event",
      kind: "remote",
      file,
      line: lineOf(needle),
      from_mod: "NeutralConstructors.Flow",
      from_fun: fromFun,
      to_mod: toMod,
      name,
      arity,
      dyn,
      partition: "prod",
    });
    const cases = [
      ["money_data/1", "money_data", "data"],
      ["money_escape/1", "money_escape", "escape"],
      ["money_sparse/1", "money_sparse", "escape"],
      ["money_duplicate/1", "money_duplicate", "escape"],
      ["money_ambiguous/1", "currency =", "escape"],
      ["ecto_three_data/2", "ecto_three_data", "data"],
      ["ecto_three_escape/2", "ecto_three_escape", "escape"],
      ["ecto_four_escape/2", "ecto_four_escape", "escape"],
      ["ecto_message_sparse/2", "ecto_message_sparse", "escape"],
    ] as const;
    const producerEvents = cases.map(([fromFun, needle]) =>
      event(fromFun, needle, "String", "to_atom", 1, true),
    );
    const moneyDuplicate = event("money_duplicate/1", "money_duplicate", "Money", "new", 2);
    const trace: TraceResult = {
      appMod: null,
      deps: ["ecto", "money"],
      dependencyApplications: [
        { compilerApp: "ecto", otpApp: "ecto" },
        { compilerApp: "money", otpApp: "money" },
      ],
      hexDependencyApplications: [
        providerApplication(ectoElixirAtomRoleSummaryProvider, "3.14.1"),
        providerApplication(moneyElixirAtomRoleSummaryProvider, "1.15.0"),
      ],
      compileOk: true,
      testPartition: "complete",
      modules: [mod("NeutralConstructors.Flow", file)],
      functions: [],
      events: [
        ...producerEvents,
        event("money_data/1", "money_data", "Money", "new", 2),
        event("money_data/1", "money_data", "Map", "fetch!", 2),
        event("money_data/1", "money_data", "Atom", "to_string", 1),
        event("money_escape/1", "money_escape", "Money", "new", 2),
        event("money_escape/1", "money_escape", "NeutralConstructors.External", "keep", 1),
        event("money_sparse/1", "money_sparse", "Money", "new", 2),
        moneyDuplicate,
        { ...moneyDuplicate },
        event("money_duplicate/1", "money_duplicate", "Map", "fetch!", 2),
        event("money_duplicate/1", "money_duplicate", "Atom", "to_string", 1),
        event("money_ambiguous/1", "{Money.new", "Money", "new", 2),
        event("ecto_three_data/2", "ecto_three_data", "Ecto.Changeset", "add_error", 3),
        event("ecto_three_data/2", "ecto_three_data", "Map", "has_key?", 2),
        event("ecto_three_escape/2", "ecto_three_escape", "Ecto.Changeset", "add_error", 3),
        event(
          "ecto_three_escape/2",
          "ecto_three_escape",
          "NeutralConstructors.External",
          "keep",
          1,
        ),
        event("ecto_four_escape/2", "ecto_four_escape", "Ecto.Changeset", "add_error", 4),
        event("ecto_four_escape/2", "ecto_four_escape", "NeutralConstructors.External", "keep", 1),
        event("ecto_message_sparse/2", "ecto_message_sparse", "Ecto.Changeset", "add_error", 3),
      ],
    };

    try {
      writeFileSync(join(root, file), `${lines.join("\n")}\n`);
      writeFileSync(join(root, "mix.lock"), dependencyLock("1.15.0", "3.14.1"));
      const extraction = extractElixirRuntimeConventions(root, trace, providers);
      expect(
        extraction.dynamicDispatches.map((fact) => [
          fact.fromFun,
          fact.factKind === "computed-atom" ? fact.flow : "invocation",
        ]),
      ).toEqual(cases.map(([fromFun, , flow]) => [fromFun, flow]));
      expect(extraction.atomFlowStats).toMatchObject({
        producers: cases.length,
        dataSinks: 2,
        escapes: 7,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("activates every audited Money release and refuses all unsupported environments", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-money-versions-"));
    const file = "money_versions.ex";
    const source =
      "defmodule NeutralMoney.Version do\n  def run(raw), do: Money.new(100, String.to_atom(raw)) |> Map.fetch!(:currency) |> Atom.to_string()\nend\n";
    const trace = moneyTrace(file);
    const flow = (candidate: TraceResult): string | undefined => {
      const fact = extractElixirRuntimeConventions(
        root,
        candidate,
        providers,
      ).dynamicDispatches.find(
        (fact) => fact.fromFun === "run/1" && fact.factKind === "computed-atom",
      );
      return fact?.factKind === "computed-atom" ? fact.flow : undefined;
    };

    try {
      writeFileSync(join(root, file), source);
      for (const version of MONEY_AUDITED_VERSIONS) {
        writeFileSync(join(root, "mix.lock"), dependencyLock(version));
        expect(
          flow({
            ...trace,
            hexDependencyApplications: [
              providerApplication(moneyElixirAtomRoleSummaryProvider, version),
            ],
          }),
          version,
        ).toBe("data");
      }

      const refused = [
        {
          lock: dependencyLock("0.0.1-dev"),
          trace: {
            ...trace,
            hexDependencyApplications: [
              providerApplication(moneyElixirAtomRoleSummaryProvider, "0.0.1-dev"),
            ],
          },
        },
        {
          lock: dependencyLock("1.15.1"),
          trace: {
            ...trace,
            hexDependencyApplications: [
              providerApplication(moneyElixirAtomRoleSummaryProvider, "1.15.1"),
            ],
          },
        },
        { lock: dependencyLock("1.15.0"), trace: { ...trace, hexDependencyApplications: [] } },
        {
          lock: '%{\n  "money": {:path, "deps/money"}\n}\n',
          trace: { ...trace, hexDependencyApplications: [] },
        },
        {
          lock: '%{\n  "money": {:git, "https://example.invalid/money.git", "ref", []}\n}\n',
          trace: { ...trace, hexDependencyApplications: [] },
        },
        {
          lock: '%{\n  "money": {:hex, :other_money, "1.15.0", "checksum", [:mix], [], "hexpm", "outer"}\n}\n',
          trace: {
            ...trace,
            hexDependencyApplications: [
              {
                ...providerApplication(moneyElixirAtomRoleSummaryProvider, "1.15.0"),
                hexPackage: "other_money",
              },
            ],
          },
        },
        { lock: "malformed", trace: { ...trace, hexDependencyApplications: [] } },
      ];
      for (const variant of refused) {
        writeFileSync(join(root, "mix.lock"), variant.lock);
        expect(flow(variant.trace)).toBe("escape");
      }
      rmSync(join(root, "mix.lock"));
      expect(flow({ ...trace, hexDependencyApplications: [] })).toBe("escape");

      writeFileSync(join(root, "mix.lock"), dependencyLock("1.15.0"));
      expect(flow({ ...trace, modules: [...trace.modules, mod("Money", file)] })).toBe("escape");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("activates both ex_money argument orders only for exact audited releases", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-ex-money-versions-"));
    const file = "ex_money_versions.ex";
    const source = [
      "defmodule NeutralExMoney.Version do",
      "  def amount_first(raw), do: Money.new(100, String.to_atom(raw)) |> Map.fetch!(:currency) |> Atom.to_string()",
      "  def currency_first(raw), do: Money.new(String.to_atom(raw), 100) |> Map.fetch!(:currency) |> Atom.to_string()",
      "end",
      "",
    ].join("\n");
    const events = ["amount_first", "currency_first"].flatMap((name, index) => [
      remote(file, index + 2, "NeutralExMoney.Version", `${name}/1`, "String", "to_atom", 1, true),
      remote(file, index + 2, "NeutralExMoney.Version", `${name}/1`, "Money", "new", 2),
      remote(file, index + 2, "NeutralExMoney.Version", `${name}/1`, "Map", "fetch!", 2),
      remote(file, index + 2, "NeutralExMoney.Version", `${name}/1`, "Atom", "to_string", 1),
    ]);
    const trace: TraceResult = {
      appMod: null,
      deps: ["ex_money"],
      dependencyApplications: [{ compilerApp: "ex_money", otpApp: "ex_money" }],
      hexDependencyApplications: [
        providerApplication(exMoneyElixirAtomRoleSummaryProvider, "6.1.1"),
      ],
      compileOk: true,
      testPartition: "complete",
      modules: [mod("NeutralExMoney.Version", file)],
      functions: [],
      events,
    };
    const flows = (candidate: TraceResult): string[] =>
      extractElixirRuntimeConventions(root, candidate, providers)
        .dynamicDispatches.filter((fact) => fact.factKind === "computed-atom")
        .map((fact) => fact.flow);

    try {
      writeFileSync(join(root, file), source);
      for (const version of EX_MONEY_AUDITED_VERSIONS) {
        writeFileSync(join(root, "mix.lock"), exMoneyLock(version));
        expect(
          flows({
            ...trace,
            hexDependencyApplications: [
              providerApplication(exMoneyElixirAtomRoleSummaryProvider, version),
            ],
          }),
          version,
        ).toEqual(["data", "data"]);
      }
      for (const version of ["5.19.0", "6.1.2"]) {
        writeFileSync(join(root, "mix.lock"), exMoneyLock(version));
        expect(
          flows({
            ...trace,
            hexDependencyApplications: [
              providerApplication(exMoneyElixirAtomRoleSummaryProvider, version),
            ],
          }),
        ).toEqual(["escape", "escape"]);
      }
      writeFileSync(join(root, "mix.lock"), exMoneyLock("6.1.1"));
      expect(
        flows({
          ...trace,
          hexDependencyApplications: [
            {
              ...providerApplication(exMoneyElixirAtomRoleSummaryProvider, "6.1.1"),
              outerChecksum: "0".repeat(64),
            },
          ],
        }),
      ).toEqual(["escape", "escape"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("activates historical Ecto add_error summaries without widening other APIs", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-ecto-version-groups-"));
    const file = "ecto_version_groups.ex";
    const source = [
      "defmodule NeutralEcto.VersionGroup do",
      '  def error(changeset, raw), do: Ecto.Changeset.add_error(changeset, String.to_atom(raw), "invalid") |> Map.has_key?(:errors)',
      "  def lookup(changeset, raw), do: Ecto.Changeset.get_change(changeset, String.to_atom(raw)) |> Atom.to_string()",
      "end",
      "",
    ].join("\n");
    const events = [
      remote(file, 2, "NeutralEcto.VersionGroup", "error/2", "String", "to_atom", 1, true),
      remote(file, 2, "NeutralEcto.VersionGroup", "error/2", "Ecto.Changeset", "add_error", 3),
      remote(file, 2, "NeutralEcto.VersionGroup", "error/2", "Map", "has_key?", 2),
      remote(file, 3, "NeutralEcto.VersionGroup", "lookup/2", "String", "to_atom", 1, true),
      remote(file, 3, "NeutralEcto.VersionGroup", "lookup/2", "Ecto.Changeset", "get_change", 2),
      remote(file, 3, "NeutralEcto.VersionGroup", "lookup/2", "Atom", "to_string", 1),
    ];
    const trace: TraceResult = {
      appMod: null,
      deps: ["ecto"],
      dependencyApplications: [{ compilerApp: "ecto", otpApp: "ecto" }],
      hexDependencyApplications: [providerApplication(ectoElixirAtomRoleSummaryProvider, "3.14.1")],
      compileOk: true,
      testPartition: "complete",
      modules: [mod("NeutralEcto.VersionGroup", file)],
      functions: [],
      events,
    };
    const flows = (version: string): Map<string, string> =>
      new Map(
        extractElixirRuntimeConventions(
          root,
          {
            ...trace,
            hexDependencyApplications: [
              providerApplication(ectoElixirAtomRoleSummaryProvider, version),
            ],
          },
          providers,
        )
          .dynamicDispatches.filter((fact) => fact.factKind === "computed-atom")
          .map((fact) => [fact.fromFun ?? "", fact.flow]),
      );

    try {
      writeFileSync(join(root, file), source);
      for (const version of ECTO_ADD_ERROR_AUDITED_VERSIONS) {
        writeFileSync(join(root, "mix.lock"), dependencyLock(undefined, version));
        const actual = flows(version);
        expect(actual.get("error/2"), version).toBe("data");
        expect(actual.get("lookup/2"), version).toBe(version === "3.14.1" ? "data" : "escape");
      }
      writeFileSync(join(root, "mix.lock"), dependencyLock(undefined, "3.11.2"));
      expect(flows("3.11.2")).toEqual(
        new Map([
          ["error/2", "escape"],
          ["lookup/2", "escape"],
        ]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when money and ex_money both own Money.new/2", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-money-provider-ambiguity-"));
    const file = "money_ambiguity.ex";
    const trace = moneyTrace(file);
    try {
      writeFileSync(
        join(root, file),
        "defmodule NeutralMoney.Version do\n  def run(raw), do: Money.new(100, String.to_atom(raw)) |> Map.fetch!(:currency) |> Atom.to_string()\nend\n",
      );
      writeFileSync(
        join(root, "mix.lock"),
        `%{\n  "money": ${hexTuple("money", "1.15.0")},\n  "ex_money": ${exMoneyTuple("6.1.1")},\n}\n`,
      );
      const extraction = extractElixirRuntimeConventions(
        root,
        {
          ...trace,
          dependencyApplications: [
            ...(trace.dependencyApplications ?? []),
            { compilerApp: "ex_money", otpApp: "ex_money" },
          ],
          hexDependencyApplications: [
            providerApplication(moneyElixirAtomRoleSummaryProvider, "1.15.0"),
            providerApplication(exMoneyElixirAtomRoleSummaryProvider, "6.1.1"),
          ],
        },
        providers,
      );
      expect(extraction.dynamicDispatches[0]).toMatchObject({
        factKind: "computed-atom",
        flow: "escape",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a project-owned Ecto.Changeset module", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-ecto-constructor-spoof-"));
    const file = "ecto_spoof.ex";
    const source =
      'defmodule NeutralEcto.Spoof do\n  def run(changeset, raw), do: Ecto.Changeset.add_error(changeset, String.to_atom(raw), "invalid") |> Map.has_key?(:errors)\nend\n';
    const events: TraceEvent[] = [
      remote(file, 2, "NeutralEcto.Spoof", "run/2", "String", "to_atom", 1, true),
      remote(file, 2, "NeutralEcto.Spoof", "run/2", "Ecto.Changeset", "add_error", 3),
      remote(file, 2, "NeutralEcto.Spoof", "run/2", "Map", "has_key?", 2),
    ];
    const trace: TraceResult = {
      appMod: null,
      deps: ["ecto"],
      dependencyApplications: [{ compilerApp: "ecto", otpApp: "ecto" }],
      hexDependencyApplications: [providerApplication(ectoElixirAtomRoleSummaryProvider, "3.14.1")],
      compileOk: true,
      testPartition: "complete",
      modules: [mod("NeutralEcto.Spoof", file)],
      functions: [],
      events,
    };

    try {
      writeFileSync(join(root, file), source);
      writeFileSync(join(root, "mix.lock"), dependencyLock(undefined, "3.14.1"));
      expect(
        extractElixirRuntimeConventions(root, trace, providers).dynamicDispatches[0],
      ).toMatchObject({ factKind: "computed-atom", flow: "data" });
      expect(
        extractElixirRuntimeConventions(
          root,
          { ...trace, modules: [...trace.modules, mod("Ecto.Changeset", file)] },
          providers,
        ).dynamicDispatches[0],
      ).toMatchObject({ factKind: "computed-atom", flow: "escape" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps fixed-density constructor summary work bounded through 2,000 sites", {
    timeout: 20_000,
  }, () => {
    const root = mkdtempSync(join(tmpdir(), "unused-constructor-scaling-"));
    const file = "constructor_scaling.ex";
    try {
      writeFileSync(join(root, "mix.lock"), exMoneyLock("6.1.1"));
      for (const count of [250, 500, 1_000, 2_000]) {
        const functions = Array.from({ length: count }, (_, index) =>
          index % 2 === 0
            ? `  def run_${index}(raw), do: Money.new(100, String.to_atom(raw)) |> Map.fetch!(:currency) |> Atom.to_string()`
            : `  def run_${index}(raw), do: Money.new(String.to_atom(raw), 100) |> Map.fetch!(:currency) |> Atom.to_string()`,
        );
        writeFileSync(
          join(root, file),
          ["defmodule NeutralMoney.Scale do", ...functions, "end", ""].join("\n"),
        );
        const events = functions.flatMap((_source, index) => [
          remote(
            file,
            index + 2,
            "NeutralMoney.Scale",
            `run_${index}/1`,
            "String",
            "to_atom",
            1,
            true,
          ),
          remote(file, index + 2, "NeutralMoney.Scale", `run_${index}/1`, "Money", "new", 2),
          remote(file, index + 2, "NeutralMoney.Scale", `run_${index}/1`, "Map", "fetch!", 2),
          remote(file, index + 2, "NeutralMoney.Scale", `run_${index}/1`, "Atom", "to_string", 1),
        ]);
        const trace: TraceResult = {
          appMod: null,
          deps: ["ex_money"],
          dependencyApplications: [{ compilerApp: "ex_money", otpApp: "ex_money" }],
          hexDependencyApplications: [
            providerApplication(exMoneyElixirAtomRoleSummaryProvider, "6.1.1"),
          ],
          compileOk: true,
          testPartition: "complete",
          modules: [mod("NeutralMoney.Scale", file)],
          functions: [],
          events,
        };
        const extraction = extractElixirRuntimeConventions(root, trace, providers);
        expect(extraction.dynamicDispatches).toHaveLength(count);
        expect(
          extraction.dynamicDispatches.every(
            (fact) => fact.factKind === "computed-atom" && fact.flow === "data",
          ),
        ).toBe(true);
        expect(extraction.atomFlowStats).toMatchObject({
          sources: 1,
          producers: count,
          summaryMatches: count * 3,
          dataSinks: count,
          escapes: 0,
        });
        expect(extraction.atomFlowStats.roleEdges).toBeLessThanOrEqual(count * 5);
        expect(extraction.atomFlowStats.queueVisits).toBeLessThanOrEqual(count * 8);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function moneyTrace(file: string): TraceResult {
  return {
    appMod: null,
    deps: ["money"],
    dependencyApplications: [{ compilerApp: "money", otpApp: "money" }],
    hexDependencyApplications: [providerApplication(moneyElixirAtomRoleSummaryProvider, "1.15.0")],
    compileOk: true,
    testPartition: "complete",
    modules: [mod("NeutralMoney.Version", file)],
    functions: [],
    events: [
      remote(file, 2, "NeutralMoney.Version", "run/1", "String", "to_atom", 1, true),
      remote(file, 2, "NeutralMoney.Version", "run/1", "Money", "new", 2),
      remote(file, 2, "NeutralMoney.Version", "run/1", "Map", "fetch!", 2),
      remote(file, 2, "NeutralMoney.Version", "run/1", "Atom", "to_string", 1),
    ],
  };
}

function mod(name: string, file: string): ModuleRecord {
  return {
    k: "module",
    mod: name,
    file,
    line: 1,
    behaviours: [],
    protocol: false,
    impl: false,
    partition: "prod",
  };
}

function remote(
  file: string,
  line: number,
  fromMod: string,
  fromFun: string,
  toMod: string,
  name: string,
  arity: number,
  dyn = false,
): TraceEvent {
  return {
    k: "event",
    kind: "remote",
    file,
    line,
    from_mod: fromMod,
    from_fun: fromFun,
    to_mod: toMod,
    name,
    arity,
    dyn,
    partition: "prod",
  };
}

function dependencyLock(money?: string, ecto?: string): string {
  const entries = [
    ...(money === undefined ? [] : [`  "money": ${hexTuple("money", money)},`]),
    ...(ecto === undefined ? [] : [`  "ecto": ${hexTuple("ecto", ecto)},`]),
  ];
  return [`%{`, ...entries, `}`, ``].join("\n");
}

function exMoneyLock(version: string): string {
  return `%{\n  "ex_money": ${exMoneyTuple(version)},\n}\n`;
}

function exMoneyTuple(version: string): string {
  const audited = exMoneyElixirAtomRoleSummaryProvider.auditedReleases.find(
    (release) => release.version === version,
  );
  const inner = audited?.innerChecksum ?? "1".repeat(64);
  const outer = audited?.outerChecksum ?? "2".repeat(64);
  return `{:hex, :ex_money, "${version}", "${inner}", [:mix], [], "hexpm", "${outer}"}`;
}

function hexTuple(dependency: string, version: string): string {
  const provider =
    dependency === "money" ? moneyElixirAtomRoleSummaryProvider : ectoElixirAtomRoleSummaryProvider;
  const audited = providerRelease(provider, version);
  const inner = audited?.innerChecksum ?? "1".repeat(64);
  const outer = audited?.outerChecksum ?? "2".repeat(64);
  return `{:hex, :${dependency}, "${version}", "${inner}", [:mix], [], "hexpm", "${outer}"}`;
}

function providerApplication(
  provider: ElixirAtomRoleSummaryProvider,
  version: string,
): HexDependencyApplication {
  const audited = providerRelease(provider, version);
  return {
    compilerApp: provider.compilerApp,
    otpApp: provider.otpApp,
    lockKey: provider.lockKey,
    hexPackage: provider.hexPackage,
    version,
    innerChecksum: audited?.innerChecksum ?? "1".repeat(64),
    repository: provider.repository,
    outerChecksum: audited?.outerChecksum ?? "2".repeat(64),
  };
}

function providerRelease(provider: ElixirAtomRoleSummaryProvider, version: string) {
  return [
    ...provider.auditedReleases,
    ...(provider.additionalReleaseGroups ?? []).flatMap((group) => group.auditedReleases),
  ].find((release) => release.version === version);
}
