import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileId, symbolId } from "../../core/ir/index.js";
import type { TraceResult } from "./events.js";
import { extractElixirScriptCommandRoots, extractElixirScriptFacts } from "./script-references.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("extractElixirScriptFacts", () => {
  it("extracts literal calls with anonymous-function arguments and multiline bodies", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-elixir-structured-calls-"));
    temporaryRoots.push(root);
    await write(
      root,
      "scripts/structured.exs",
      [
        "Neutral.Target.one(fn left, right -> Neutral.Target.zero() end)",
        "Neutral.Target.one(",
        "  :multiline",
        ")",
        "# Neutral.Target.one(fn -> :comment end)",
        'IO.puts("Neutral.Target.one(\\n  :text\\n)")',
      ].join("\n"),
    );

    const facts = extractElixirScriptFacts(root, [join(root, "scripts/structured.exs")], trace());
    expect(
      facts.contribution.edges
        ?.filter((edge) => edge.to === symbolId("lib/target.ex", "Neutral.Target.one/1"))
        .map((edge) => edge.site.span.startLine),
    ).toEqual([1, 2]);
  });

  it("keeps nested delimiters and anonymous clauses inside one argument without text edges", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-elixir-nested-calls-"));
    temporaryRoots.push(root);
    const content = [
      "😀",
      "Neutral.Target.two(",
      "  %{callback: fn left, right -> {left, right} end},",
      "  [fn value -> Neutral.Target.zero() end]",
      ")",
      "# Neutral.Target.two(:comment, :comment)",
      'IO.puts("Neutral.Target.two(:text, :text)")',
      '"""',
      "Neutral.Target.two(:heredoc, :heredoc)",
      '"""',
      "Neutral.Target.two  (:fn), :end",
      "Neutral.Target.two(value >>> 1, :shifted)",
    ].join("\n");
    await write(root, "scripts/nested.exs", content);
    const baseTrace = trace();
    const facts = extractElixirScriptFacts(root, [join(root, "scripts/nested.exs")], {
      ...baseTrace,
      functions: [
        ...baseTrace.functions,
        {
          k: "function",
          mod: "Neutral.Target",
          name: "two",
          arity: 2,
          file: "lib/target.ex",
          line: 4,
          partition: "prod",
        },
        {
          k: "function",
          mod: "Neutral.Target",
          name: "two",
          arity: 1,
          file: "lib/target.ex",
          line: 5,
          partition: "prod",
        },
      ],
    });
    const functionEdges = facts.contribution.edges?.filter(
      (edge) => edge.kind === "references" && edge.to.startsWith("symbol:lib/target.ex#"),
    );
    expect(functionEdges).toContainEqual(
      expect.objectContaining({
        to: symbolId("lib/target.ex", "Neutral.Target.two/2"),
        site: expect.objectContaining({
          span: expect.objectContaining({
            start: content.indexOf("Neutral.Target.two("),
            startLine: 2,
          }),
        }),
      }),
    );
    expect(
      functionEdges?.filter(
        (edge) => edge.to === symbolId("lib/target.ex", "Neutral.Target.zero/0"),
      ),
    ).toHaveLength(1);
    expect(
      functionEdges?.some(
        (edge) => edge.site.span.startLine >= 6 && edge.site.span.startLine <= 10,
      ),
    ).toBe(false);
    expect(
      functionEdges?.filter(
        (edge) => edge.to === symbolId("lib/target.ex", "Neutral.Target.two/2"),
      ),
    ).toHaveLength(3);
    expect(
      functionEdges?.filter(
        (edge) => edge.to === symbolId("lib/target.ex", "Neutral.Target.two/1"),
      ),
    ).toHaveLength(0);
  });

  it("collapses keyword lists and fails closed for nested no-parentheses expressions", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-elixir-keyword-calls-"));
    temporaryRoots.push(root);
    const content = [
      "Neutral.Target.keyword(do: :x, end: :y)",
      "Neutral.Target.keyword(:x, left: 1, right: 2)",
      "Neutral.Target.nested(if condition, do: :left, else: :right)",
      "Neutral.Target.nested(build left, right)",
      "Neutral.Target.operator(value + 1, other)",
      "Neutral.Target.operator(left: value + 1)",
      "Neutral.Target.operator(not value)",
      "Neutral.Target.operator(left && right)",
      "Neutral.Target.operator(& &1)",
      "Neutral.Target.operator(build left)",
      "Neutral.Target.operator(:lead, build left)",
      "Neutral.Target.operator(build left, right)",
      "Neutral.Target.operator(value . field, other)",
    ].join("\n");
    await write(root, "scripts/keywords.exs", content);
    const baseTrace = trace();
    const overloads = [
      ...[1, 2, 3].map((arity) => ({
        k: "function" as const,
        mod: "Neutral.Target",
        name: "keyword",
        arity,
        file: "lib/target.ex",
        line: 10 + arity,
        partition: "prod" as const,
      })),
      ...[1, 2, 3].map((arity) => ({
        k: "function" as const,
        mod: "Neutral.Target",
        name: "operator",
        arity,
        file: "lib/target.ex",
        line: 30 + arity,
        partition: "prod" as const,
      })),
      ...[1, 2, 3].map((arity) => ({
        k: "function" as const,
        mod: "Neutral.Target",
        name: "nested",
        arity,
        file: "lib/target.ex",
        line: 20 + arity,
        partition: "prod" as const,
      })),
    ];
    const facts = extractElixirScriptFacts(root, [join(root, "scripts/keywords.exs")], {
      ...baseTrace,
      functions: [...baseTrace.functions, ...overloads],
    });
    const linesFor = (name: string, arity: number): number[] =>
      facts.contribution.edges
        ?.filter(
          (edge) =>
            edge.kind === "references" &&
            edge.to === symbolId("lib/target.ex", `Neutral.Target.${name}/${arity}`),
        )
        .map((edge) => edge.site.span.startLine) ?? [];

    expect(linesFor("keyword", 1)).toEqual([1]);
    expect(linesFor("keyword", 2)).toEqual([2]);
    expect(linesFor("keyword", 3)).toEqual([]);
    expect(linesFor("nested", 1)).toEqual([3, 4]);
    expect(linesFor("nested", 2)).toEqual([3, 4]);
    expect(linesFor("nested", 3)).toEqual([3, 4]);
    expect(linesFor("operator", 1)).toEqual([6, 7, 8, 9, 10, 12]);
    expect(linesFor("operator", 2)).toEqual([5, 11, 12, 13]);
    expect(linesFor("operator", 3)).toEqual([12]);
  });

  it("counts masked literal arguments without extracting their bodies", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-elixir-literal-calls-"));
    temporaryRoots.push(root);
    const content = [
      'Neutral.Target.literal("value")',
      'Neutral.Target.literal("left", "right")',
      'Neutral.Target.literal("""',
      "Neutral.Target.literal(:heredoc_text)",
      '""")',
      'Neutral.Target.literal("value #{Neutral.Target.literal(:interpolated)}")',
      "Neutral.Target.literal('charlist')",
      'Neutral.Target.keyword("left": 1, "right": 2)',
      '# Neutral.Target.literal("comment")',
      'IO.puts("Neutral.Target.literal(:string_text)")',
    ].join("\n");
    await write(root, "scripts/literals.exs", content);
    const baseTrace = trace();
    const overloads = [
      ...[1, 2, 3].map((arity) => ({
        k: "function" as const,
        mod: "Neutral.Target",
        name: "literal",
        arity,
        file: "lib/target.ex",
        line: 40 + arity,
        partition: "prod" as const,
      })),
      ...[1, 2].map((arity) => ({
        k: "function" as const,
        mod: "Neutral.Target",
        name: "keyword",
        arity,
        file: "lib/target.ex",
        line: 50 + arity,
        partition: "prod" as const,
      })),
    ];
    const facts = extractElixirScriptFacts(root, [join(root, "scripts/literals.exs")], {
      ...baseTrace,
      functions: [...baseTrace.functions, ...overloads],
    });
    const linesFor = (name: string, arity: number): number[] =>
      facts.contribution.edges
        ?.filter(
          (edge) =>
            edge.kind === "references" &&
            edge.to === symbolId("lib/target.ex", `Neutral.Target.${name}/${arity}`),
        )
        .map((edge) => edge.site.span.startLine) ?? [];

    expect(linesFor("literal", 1)).toEqual([1, 3, 6, 7]);
    expect(linesFor("literal", 2)).toEqual([2]);
    expect(linesFor("literal", 3)).toEqual([]);
    expect(linesFor("keyword", 1)).toEqual([8]);
    expect(linesFor("keyword", 2)).toEqual([]);
  });

  it("adds unrooted script files and exact alias, call, and MFA references", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-elixir-scripts-"));
    const outside = await mkdtemp(join(tmpdir(), "unused-elixir-external-"));
    temporaryRoots.push(root, outside);
    await Promise.all([
      write(
        root,
        "scripts/neutral.exs",
        [
          "alias Neutral.Target, as: Target",
          "Target.zero()",
          "Neutral.Target.one(:value)",
          "callback = {Target, :zero, []}",
          "# Neutral.Target.zero()",
          "callback",
        ].join("\n"),
      ),
      write(root, "config/runtime.exs", "Neutral.Target.zero()\n"),
      write(root, "test/helper.exs", "Neutral.Target.zero()\n"),
      write(root, "mix.exs", "Neutral.Target.zero()\n"),
      write(root, "lib/traced.exs", "defmodule Neutral.Traced do\nend\n"),
      write(outside, "external.exs", "Neutral.Target.zero()\n"),
    ]);

    const facts = extractElixirScriptFacts(
      root,
      [
        join(root, "scripts/neutral.exs"),
        join(root, "scripts/neutral.exs"),
        join(root, "config/runtime.exs"),
        join(root, "test/helper.exs"),
        join(root, "mix.exs"),
        join(root, "lib/traced.exs"),
        join(outside, "external.exs"),
      ],
      trace(),
    );

    expect(facts.files).toEqual(["scripts/neutral.exs"]);
    expect(facts.contribution.nodes).toEqual([
      { kind: "file", id: fileId("scripts/neutral.exs"), path: "scripts/neutral.exs" },
    ]);
    expect(facts.fileLineCounts.get(fileId("scripts/neutral.exs"))).toBe(6);
    expect(
      facts.contribution.edges?.map((edge) => ({
        kind: edge.referenceKind,
        line: edge.site.span.startLine,
        to: edge.to,
      })),
    ).toEqual([
      { kind: "static", line: 1, to: symbolId("lib/target.ex", "Neutral.Target") },
      { kind: "static", line: 2, to: symbolId("lib/target.ex", "Neutral.Target") },
      { kind: "static", line: 2, to: symbolId("lib/target.ex", "Neutral.Target.zero/0") },
      { kind: "static", line: 3, to: symbolId("lib/target.ex", "Neutral.Target") },
      { kind: "static", line: 3, to: symbolId("lib/target.ex", "Neutral.Target.one/1") },
      { kind: "runtime-resolved", line: 4, to: symbolId("lib/target.ex", "Neutral.Target.zero/0") },
      { kind: "static", line: 4, to: symbolId("lib/target.ex", "Neutral.Target") },
    ]);
  });

  it("models exact script loads and caps opaque script-defined or dynamic surfaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-elixir-script-surfaces-"));
    temporaryRoots.push(root);
    await Promise.all([
      write(root, "scripts/helper.exs", "defmodule Script.Helper do\n  def value, do: :ok\nend\n"),
      write(root, "scripts/caller.exs", "Script.Helper.value()\n"),
      write(root, "scripts/loader.exs", 'Code.require_file("helper.exs", __DIR__)\n'),
      write(root, "scripts/bare_loader.exs", 'Code.require_file "helper.exs", __DIR__\n'),
      write(root, "scripts/dynamic.exs", "Code.require_file(path)\n"),
      write(root, "scripts/install.exs", "Mix.install([])\n"),
      write(
        root,
        "scripts/text.exs",
        [
          "# Neutral.Target.zero() {Neutral.Target, :one, []}",
          'IO.puts("Neutral.Target.zero() {Neutral.Target, :one, []} Mix.install(")',
          '"""',
          "Neutral.Target.one(:value)",
          "{Neutral.Target, :zero, []}",
          "apply(",
          '"""',
        ].join("\n"),
      ),
      write(root, "scripts/bare_install.exs", "Mix.install deps\n"),
      write(
        root,
        "scripts/bare_dynamic.exs",
        "#!/usr/bin/env elixir\nNeutral.Target.zero()\napply mod, fun, args\n",
      ),
      write(root, "scripts/unicode.exs", '😀\nIO.puts("Mix.install(")\nNeutral.Target.zero()\n'),
      write(
        root,
        "scripts/rooted_call.exs",
        "#!/usr/bin/env elixir\nalias Neutral.{Target}\nTarget.one :value\nTarget.zero\n_capture = &Target.one/1\n",
      ),
      write(root, "scripts/shebang.exs", "#!/usr/bin/env elixir\nIO.puts(:ok)\n"),
      write(root, "scripts/executable.exs", "IO.puts(:ok)\n"),
    ]);
    await chmod(join(root, "scripts/executable.exs"), 0o755);
    const sources = [
      "caller.exs",
      "bare_loader.exs",
      "bare_dynamic.exs",
      "bare_install.exs",
      "dynamic.exs",
      "executable.exs",
      "helper.exs",
      "install.exs",
      "loader.exs",
      "rooted_call.exs",
      "shebang.exs",
      "text.exs",
      "unicode.exs",
    ].map((file) => join(root, "scripts", file));

    const facts = extractElixirScriptFacts(root, sources, trace());
    expect(
      facts.contribution.nodes
        ?.filter((node) => node.kind === "entrypoint")
        .map((node) => ({ file: node.file, reason: node.reason }))
        .sort((a, b) => a.file.localeCompare(b.file)),
    ).toEqual([
      { file: "scripts/bare_dynamic.exs", reason: "elixir:shebang-script" },
      { file: "scripts/bare_install.exs", reason: "elixir:mix-install-script" },
      { file: "scripts/executable.exs", reason: "elixir:executable-script" },
      { file: "scripts/install.exs", reason: "elixir:mix-install-script" },
      { file: "scripts/rooted_call.exs", reason: "elixir:shebang-script" },
      { file: "scripts/shebang.exs", reason: "elixir:shebang-script" },
    ]);
    expect(facts.contribution.nodes).toContainEqual(
      expect.objectContaining({
        kind: "symbol",
        id: symbolId("scripts/helper.exs", "Script.Helper"),
      }),
    );
    expect(facts.contribution.edges).toContainEqual(
      expect.objectContaining({
        kind: "references",
        referenceKind: "side-effect",
        from: fileId("scripts/loader.exs"),
        to: fileId("scripts/helper.exs"),
      }),
    );
    expect(facts.contribution.edges).toContainEqual(
      expect.objectContaining({
        referenceKind: "static",
        from: fileId("scripts/rooted_call.exs"),
        to: symbolId("lib/target.ex", "Neutral.Target.zero/0"),
      }),
    );
    expect(facts.contribution.edges).toContainEqual(
      expect.objectContaining({
        kind: "references",
        referenceKind: "side-effect",
        from: fileId("scripts/bare_loader.exs"),
        to: fileId("scripts/helper.exs"),
      }),
    );
    expect(facts.contribution.edges).toContainEqual(
      expect.objectContaining({
        kind: "references",
        referenceKind: "static",
        from: fileId("scripts/caller.exs"),
        to: symbolId("scripts/helper.exs", "Script.Helper"),
      }),
    );
    expect(
      facts.contribution.hazards?.map((hazard) => ({
        file: hazard.site.file,
        hazardClass: hazard.hazardClass,
      })),
    ).toEqual([
      { file: "scripts/bare_dynamic.exs", hazardClass: "elixir-script-opaque" },
      { file: "scripts/bare_dynamic.exs", hazardClass: "elixir-dynamic-dispatch" },
      { file: "scripts/bare_dynamic.exs", hazardClass: "elixir-dynamic-dispatch" },
      { file: "scripts/dynamic.exs", hazardClass: "elixir-script-opaque" },
      { file: "scripts/helper.exs", hazardClass: "elixir-script-opaque" },
      { file: "scripts/rooted_call.exs", hazardClass: "elixir-dynamic-dispatch" },
    ]);
    expect(
      facts.contribution.nodes?.some(
        (node) => node.kind === "entrypoint" && node.file === "scripts/text.exs",
      ),
    ).toBe(false);
    expect(facts.contribution.edges?.some((edge) => edge.site.file === "scripts/text.exs")).toBe(
      false,
    );
    const bareDynamicHazards = facts.contribution.hazards?.filter(
      (hazard) =>
        hazard.site.file === "scripts/bare_dynamic.exs" &&
        hazard.hazardClass === "elixir-dynamic-dispatch",
    );
    expect(bareDynamicHazards).toHaveLength(2);
    expect(bareDynamicHazards).toContainEqual(
      expect.objectContaining({
        affectedSymbols: [
          symbolId("lib/target.ex", "Neutral.Target.one/1"),
          symbolId("lib/target.ex", "Neutral.Target.zero/0"),
        ],
      }),
    );
    expect(bareDynamicHazards?.some((hazard) => hazard.affectedSymbols === undefined)).toBe(true);
    expect(facts.contribution.edges).toContainEqual(
      expect.objectContaining({
        referenceKind: "static",
        from: fileId("scripts/rooted_call.exs"),
        to: symbolId("lib/target.ex", "Neutral.Target.one/1"),
      }),
    );
    expect(facts.contribution.edges).toContainEqual(
      expect.objectContaining({
        referenceKind: "static",
        from: fileId("scripts/rooted_call.exs"),
        to: symbolId("lib/target.ex", "Neutral.Target.one/1"),
        site: expect.objectContaining({ span: expect.objectContaining({ startLine: 5 }) }),
      }),
    );
    expect(facts.contribution.edges).toContainEqual(
      expect.objectContaining({
        referenceKind: "static",
        from: fileId("scripts/unicode.exs"),
        to: symbolId("lib/target.ex", "Neutral.Target.zero/0"),
        site: expect.objectContaining({ span: expect.objectContaining({ startLine: 3 }) }),
      }),
    );
  });

  it("roots only public framework-owned script paths under matching dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-elixir-framework-scripts-"));
    temporaryRoots.push(root);
    const relativeFiles = [
      ".formatter.exs",
      ".iex.exs",
      "priv/repo/migrations/20260722000000_create_neutral.exs",
      "priv/custom/migrations/generated.exs",
      "priv/repo/seeds.exs",
      "priv/repo/seeds_demo.exs",
      "priv/repo/arbitrary.exs",
      "scripts/arbitrary.exs",
    ];
    await Promise.all(relativeFiles.map((file) => write(root, file, "IO.puts(:neutral)\n")));

    const facts = extractElixirScriptFacts(
      root,
      relativeFiles.map((file) => join(root, file)),
      trace(["ecto_sql", "phoenix"]),
    );
    expect(
      facts.contribution.nodes
        ?.filter((node) => node.kind === "entrypoint")
        .map((node) => ({ file: node.file, reason: node.reason })),
    ).toEqual([
      { file: ".formatter.exs", reason: "elixir:formatter-config" },
      { file: ".iex.exs", reason: "elixir:iex-config" },
      { file: "priv/custom/migrations/generated.exs", reason: "elixir:ecto-migration" },
      {
        file: "priv/repo/migrations/20260722000000_create_neutral.exs",
        reason: "elixir:ecto-migration",
      },
      { file: "priv/repo/seeds.exs", reason: "elixir:ecto-seeds" },
      { file: "priv/repo/seeds_demo.exs", reason: "elixir:ecto-seeds" },
    ]);
    expect(facts.files).toContain("priv/repo/arbitrary.exs");
    expect(facts.files).toContain("scripts/arbitrary.exs");

    const withoutFramework = extractElixirScriptFacts(
      root,
      relativeFiles.map((file) => join(root, file)),
      trace(),
    );
    expect(
      withoutFramework.contribution.nodes
        ?.filter((node) => node.kind === "entrypoint")
        .map((node) => node.kind === "entrypoint" && node.file),
    ).toEqual([".formatter.exs", ".iex.exs"]);
  });

  it("roots a large generated Ecto migration inventory without widening priv scripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-elixir-migration-inventory-"));
    temporaryRoots.push(root);
    const migrations = Array.from(
      { length: 300 },
      (_, index) =>
        `priv/neutral_repo/migrations/${String(index).padStart(14, "0")}_neutral_${index}.exs`,
    );
    await Promise.all([
      ...migrations.map((file) => write(root, file, "use Ecto.Migration\n")),
      write(root, "priv/neutral_repo/manual_audit.exs", "IO.puts(:manual)\n"),
    ]);

    const facts = extractElixirScriptFacts(
      root,
      [...migrations, "priv/neutral_repo/manual_audit.exs"].map((file) => join(root, file)),
      trace(["ecto_sql"]),
    );
    const rooted = new Set(
      facts.contribution.nodes
        ?.filter((node) => node.kind === "entrypoint")
        .map((node) => node.file),
    );
    expect(rooted.size).toBe(300);
    for (const migration of migrations) expect(rooted.has(migration)).toBe(true);
    expect(rooted.has("priv/neutral_repo/manual_audit.exs")).toBe(false);
  });

  it("roots exact scripts named by workflow and Taskfile commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-elixir-script-carriers-"));
    temporaryRoots.push(root);
    await Promise.all([
      write(
        root,
        ".github/workflows/audit.yml",
        [
          "jobs:",
          "  audit:",
          "    steps:",
          "      - run: mix run scripts/workflow.exs",
          "      - run: mix run -e scripts/unreferenced.exs",
          "      - run: elixir --require scripts/required.exs -e :ok",
        ].join("\n"),
      ),
      write(root, "Taskfile.yml", "tasks:\n  audit:\n    cmds:\n      - elixir scripts/task.exs\n"),
      write(root, "scripts/workflow.exs", "IO.puts(:workflow)\n"),
      write(root, "scripts/task.exs", "IO.puts(:task)\n"),
      write(root, "scripts/required.exs", "IO.puts(:required)\n"),
      write(root, "scripts/unreferenced.exs", "IO.puts(:dead)\n"),
    ]);

    const roots = await extractElixirScriptCommandRoots(
      root,
      new Set([
        "scripts/workflow.exs",
        "scripts/task.exs",
        "scripts/required.exs",
        "scripts/unreferenced.exs",
      ]),
    );
    expect(
      roots.nodes?.map((node) =>
        node.kind === "entrypoint" ? { file: node.file, reason: node.reason } : node,
      ),
    ).toEqual([
      { file: "scripts/required.exs", reason: "config:github-actions:run" },
      { file: "scripts/task.exs", reason: "config:taskfile:cmd" },
      { file: "scripts/workflow.exs", reason: "config:github-actions:run" },
    ]);
  });
});

async function write(root: string, file: string, content: string): Promise<void> {
  const path = join(root, file);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

function trace(deps: readonly string[] = []): TraceResult {
  return {
    events: [],
    modules: [
      {
        k: "module",
        mod: "Neutral.Target",
        file: "lib/target.ex",
        line: 1,
        behaviours: [],
        protocol: false,
        impl: false,
        partition: "prod",
      },
      {
        k: "module",
        mod: "Neutral.Traced",
        file: "lib/traced.exs",
        line: 1,
        behaviours: [],
        protocol: false,
        impl: false,
        partition: "prod",
      },
    ],
    functions: [
      {
        k: "function",
        mod: "Neutral.Target",
        name: "zero",
        arity: 0,
        file: "lib/target.ex",
        line: 2,
        partition: "prod",
      },
      {
        k: "function",
        mod: "Neutral.Target",
        name: "one",
        arity: 1,
        file: "lib/target.ex",
        line: 3,
        partition: "prod",
      },
    ],
    appMod: null,
    deps,
    compileOk: true,
    testPartition: "complete",
  };
}
