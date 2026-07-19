import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Claim } from "../../core/claims/types.js";
import { fileId } from "../../core/ir/index.js";
import { analyzeProject, analyzeProjectWithGraph } from "./analyze.js";
import { cdkNodejsFunctionReferences } from "./convention-references.js";

const FIXED_CLOCK = new Date(0);
const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../../../../fixtures/ts/${name}`, import.meta.url));

function fileClaims(claims: readonly Claim[]): Claim[] {
  return claims.filter((claim) => claim.subject.kind === "file");
}

const temporaryProjects: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryProjects.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("external convention references", () => {
  it.each([
    [
      "cdk-nodejs-function-entry",
      [
        "packages/infra/lib/local-handler.ts",
        "packages/runtime/src/handler.ts",
        "packages/runtime/src/namespace-handler.ts",
        "packages/runtime/src/namespace-local-handler.ts",
      ],
      [
        "packages/infra/local-handler.ts",
        "packages/runtime/src/module-shadowed.ts",
        "packages/runtime/src/namespace-shadowed.ts",
        "packages/runtime/src/orphan.ts",
      ],
    ],
    ["audio-worklet-public-asset", ["public/capture-processor.js"], "public/orphan-processor.js"],
    ["msw-worker-directory", ["public/mockServiceWorker.js"], "public/orphan-worker.js"],
    [
      "github-actions-run-script",
      ["scripts/verify-bundle.mjs"],
      ["scripts/orphan.mjs", "scripts/read-only-argument.mjs"],
    ],
    [
      "taskfile-command",
      [
        "automation/included.mjs",
        "scripts/array.mjs",
        "scripts/command-condition.mjs",
        "scripts/command-object.mjs",
        "scripts/condition.mjs",
        "scripts/deferred.mjs",
        "scripts/generate-assets.mjs",
        "scripts/precondition-object.mjs",
        "scripts/precondition.mjs",
        "scripts/root-environment.mjs",
        "scripts/root-variable.mjs",
        "scripts/simple.mjs",
        "scripts/singular.mjs",
        "scripts/status.mjs",
        "scripts/task-environment.mjs",
        "scripts/task-variable.mjs",
        "automation/include-variable.mjs",
        "automation/runtime/include-alpha.mjs",
        "automation/runtime/include-beta.mjs",
        "runtime/direct-build.mjs",
        "runtime/direct-clean.mjs",
        "runtime/cli-k6-smoke.js",
        "runtime/cli-k6-quoted-smoke.js",
        "runtime/cli-node.mjs",
        "runtime/cli-node-quoted.mjs",
        "runtime/load-smoke.js",
        "runtime/load-stress.js",
        "runtime/node-alpha.mjs",
        "runtime/node-beta.mjs",
        "runtime/pipeline-alpha.mjs",
        "runtime/spaced-alpha beta.mjs",
        "runtime/static-runner.mjs",
      ],
      [
        "runtime/argument-control.mjs",
        "runtime/include-root-control.mjs",
        "runtime/node-nested/hidden.mjs",
        "runtime/nonexec-array.mjs",
        "runtime/nonexec-direct.mjs",
        "runtime/nonexec-quoted.mjs",
        "runtime/unsafe-alpha beta.mjs",
        "runtime/unsafe-alpha&beta.mjs",
        "runtime/unsafe-alpha;beta.mjs",
        "runtime/unsafe-alpha|beta.mjs",
        "scripts/dist-overridden.mjs",
        "scripts/orphan.mjs",
        "scripts/read-only-argument.mjs",
      ],
    ],
    ["vite-vitest-config-paths", ["src/client.ts", "src/test/setup.ts"], "src/orphan.ts"],
    ["browser-html-script", ["src/js/dashboard.js"], "src/js/orphan.js"],
    [
      "browser-extension-manifest",
      ["extension/background.ts", "extension/content.ts"],
      "extension/orphan.ts",
    ],
    ["service-worker-public-asset", ["public/runtime-worker.js"], "public/orphan-worker.js"],
    ["k6-package-script", ["load/smoke.js"], "load/orphan.js"],
    [
      "native-config-script",
      [
        "scripts/prepare-gradle.mjs",
        "scripts/prepare-mobile.mjs",
        "scripts/prepare-pods.mjs",
        "scripts/prepare-pods-command-line.mjs",
        "scripts/prepare-pods-kernel.mjs",
        "scripts/prepare-pods-kernel-colon.mjs",
        "scripts/prepare-pods-root-kernel.mjs",
        "scripts/prepare-pods-command-comment.mjs",
        "scripts/prepare-pods-command-and.mjs",
        "scripts/prepare-pods-command-comment-continuation.mjs",
        "scripts/prepare-pods-command-multiline.mjs",
        "scripts/prepare-pods-command-modifier.mjs",
        "scripts/prepare-pods-command-semicolon.mjs",
        "scripts/prepare-pods-command-symbol-and.mjs",
        "scripts/prepare-pods-kernel-multiline.mjs",
        "scripts/prepare-pods-kernel-comment-continuation.mjs",
        "scripts/prepare-pods-kernel-or.mjs",
        "scripts/prepare-pods-kernel-symbol-or.mjs",
        "scripts/prepare-pods-after-shift.mjs",
        // Valid Ruby boundaries containing `"`/`#` must never poison discovery
        // of a real same-line or later system call.
        "scripts/prepare-pods-after-block-quote.mjs",
        "scripts/prepare-pods-after-chained-assignment.mjs",
        "scripts/prepare-pods-after-heredoc-quote.mjs",
        "scripts/prepare-pods-after-literal-shift.mjs",
        "scripts/prepare-pods-after-parameter-shift.mjs",
        "scripts/prepare-pods-after-percent-quote.mjs",
        "scripts/prepare-pods-after-regex-hash.mjs",
        "scripts/prepare-pods-after-regex-quote.mjs",
        "scripts/prepare-pods-after-unicode.mjs",
        "scripts/prepare-pods-interpolated-heredoc.mjs",
        "scripts/prepare-pods-interpolated-string.mjs",
        "scripts/prepare-srcroot.mjs",
        "scripts/pod-backtick-heredoc-control.mjs",
        "scripts/pod-block-comment-control.mjs",
        "scripts/pod-expression-heredoc-control.mjs",
        "scripts/pod-heredoc-control.mjs",
        // Deliberate precision-first recall misses: token discovery also scans
        // inert comments and strings so they cannot hide subsequent real code.
        "scripts/pod-line-comment-control.mjs",
        "scripts/pod-malformed-heredoc-control.mjs",
        "scripts/pod-member-heredoc-control.mjs",
        "scripts/pod-percent-interpolated-control.mjs",
        "scripts/pod-percent-raw-control.mjs",
        "scripts/pod-punctuation-heredoc-control.mjs",
        "scripts/pod-quoted-string-control.mjs",
        "scripts/pod-regex-control.mjs",
        "scripts/pod-scope-heredoc-control.mjs",
        "scripts/pod-uppercase-heredoc-control.mjs",
      ],
      ["scripts/orphan.mjs", "scripts/pod-receiver-control.mjs"],
    ],
    ["msw-handler-registration", ["src/handlers.ts"], "src/orphan-handlers.ts"],
  ])(
    "%s keeps the convention target alive and preserves its dead control",
    async (caseName, liveFiles, dead) => {
      const run = await analyzeProject(fixture(caseName), { now: FIXED_CLOCK });
      const claims = fileClaims(run.claims);

      for (const live of liveFiles) {
        expect(claims.some((claim) => claim.subject.loc.file === live)).toBe(false);
      }
      const deadFiles = typeof dead === "string" ? [dead] : dead;
      expect(claims).toHaveLength(deadFiles.length);
      for (const deadFile of deadFiles) {
        expect(claims).toContainEqual(
          expect.objectContaining({
            subject: expect.objectContaining({
              kind: "file",
              name: deadFile,
              loc: expect.objectContaining({ file: deadFile }),
            }),
            verdict: "unused",
            confidence: "high",
          }),
        );
      }
    },
  );

  it("does not root a source-carried target when its carrier is unreachable", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-convention-edge-"));
    temporaryProjects.push(root);
    await Promise.all(
      ["src", "infra", "functions", "public"].map((dir) =>
        mkdir(join(root, dir), { recursive: true }),
      ),
    );
    await Promise.all([
      writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "unreachable-carrier", type: "module", main: "src/index.ts" }),
      ),
      writeFile(join(root, "cdk.json"), JSON.stringify({ app: "npx tsx src/index.ts" })),
      writeFile(join(root, "src/index.ts"), "export const live = true;\n"),
      writeFile(
        join(root, "infra/dead-stack.ts"),
        [
          'import { join } from "node:path";',
          "declare class NodejsFunction { constructor(a: unknown, b: string, c: unknown); }",
          "new NodejsFunction({}, 'Dead', {",
          '  entry: join(import.meta.dirname, "../functions/dead-handler.ts"),',
          "});",
          "",
        ].join("\n"),
      ),
      writeFile(join(root, "functions/dead-handler.ts"), "export const handler = () => 1;\n"),
      writeFile(
        join(root, "src/dead-audio.ts"),
        [
          "export async function load(context: AudioContext) {",
          '  await context.audioWorklet.addModule("/dead-processor.js");',
          "}",
          "",
        ].join("\n"),
      ),
      writeFile(join(root, "public/dead-processor.js"), "registerProcessor('dead', class {});\n"),
      writeFile(
        join(root, "src/dead-service-worker.ts"),
        [
          "export async function register() {",
          '  await navigator.serviceWorker.register("/dead-service-worker.js");',
          "}",
          "",
        ].join("\n"),
      ),
      writeFile(join(root, "public/dead-service-worker.js"), "export const dead = true;\n"),
    ]);

    const run = await analyzeProjectWithGraph(root, { now: FIXED_CLOCK });
    for (const target of [
      "functions/dead-handler.ts",
      "public/dead-processor.js",
      "public/dead-service-worker.js",
    ]) {
      expect(
        run.graph.edges().some((edge) => edge.to === fileId(target)),
        `${target} should have a convention edge`,
      ).toBe(true);
      expect(run.reachability.production.reachableFiles.has(fileId(target))).toBe(false);
      expect(run.reachability.config.reachableFiles.has(fileId(target))).toBe(false);
    }
  });

  it("does not guess through a dynamic CDK entry-path value", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-cdk-dynamic-entry-"));
    temporaryProjects.push(root);
    await Promise.all(
      ["src", "infra", "functions"].map((dir) => mkdir(join(root, dir), { recursive: true })),
    );
    await Promise.all([
      writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "dynamic-cdk-entry", type: "module", main: "src/index.ts" }),
      ),
      writeFile(join(root, "cdk.json"), JSON.stringify({ app: "npx tsx src/index.ts" })),
      writeFile(join(root, "src/index.ts"), 'import "../infra/stack.js";\n'),
      writeFile(
        join(root, "infra/stack.ts"),
        [
          'import { join } from "node:path";',
          "declare class NodejsFunction { constructor(a: unknown, b: string, c: unknown); }",
          "declare function runtimeDirectory(): string;",
          "new NodejsFunction({}, 'Worker', {",
          '  entry: join(runtimeDirectory(), "handler.ts"),',
          "});",
          "",
        ].join("\n"),
      ),
      writeFile(join(root, "functions/handler.ts"), "export const handler = () => 1;\n"),
    ]);

    const run = await analyzeProjectWithGraph(root, { now: FIXED_CLOCK });
    expect(run.graph.edges().some((edge) => edge.to === fileId("functions/handler.ts"))).toBe(
      false,
    );
    expect(
      fileClaims(run.result.claims).some(
        (claim) => claim.subject.loc.file === "functions/handler.ts",
      ),
    ).toBe(true);
  });

  it.each([
    [
      "parameter shadow",
      [
        'import { join } from "node:path";',
        'const runtimeDir = join(__dirname, "../runtime");',
        "function build(runtimeDir: string) {",
        '  new NodejsFunction({}, "Worker", { entry: join(runtimeDir, "handler.ts") });',
        "}",
      ].join("\n"),
    ],
    [
      "dirname parameter shadow",
      [
        'import { join } from "node:path";',
        "function build(__dirname: string) {",
        '  new NodejsFunction({}, "Worker", { entry: join(__dirname, "../runtime/handler.ts") });',
        "}",
      ].join("\n"),
    ],
    [
      "let shadow",
      [
        'import * as path from "node:path";',
        'const runtimeDir = path.join(__dirname, "../runtime");',
        "function build() {",
        "  let runtimeDir = dynamicDirectory();",
        '  new NodejsFunction({}, "Worker", { entry: path.join(runtimeDir, "handler.ts") });',
        "}",
      ].join("\n"),
    ],
    [
      "var shadow",
      [
        'import { resolve } from "node:path";',
        'const runtimeDir = resolve(__dirname, "../runtime");',
        "function build() {",
        "  var runtimeDir = dynamicDirectory();",
        '  new NodejsFunction({}, "Worker", { entry: resolve(runtimeDir, "handler.ts") });',
        "}",
      ].join("\n"),
    ],
    [
      "nested var call shadow",
      [
        'import { join } from "node:path";',
        "function build(flag: boolean) {",
        "  if (flag) { var join = (...parts: string[]) => parts[0] ?? ''; }",
        '  new NodejsFunction({}, "Worker", { entry: join(__dirname, "../runtime/handler.ts") });',
        "}",
      ].join("\n"),
    ],
    [
      "nested var dirname shadow",
      [
        'import { join } from "node:path";',
        "function build(flag: boolean) {",
        "  for (; flag; ) { var __dirname = dynamicDirectory(); break; }",
        '  new NodejsFunction({}, "Worker", { entry: join(__dirname, "../runtime/handler.ts") });',
        "}",
      ].join("\n"),
    ],
    [
      "program nested var dirname shadow",
      [
        'import { join } from "node:path";',
        "if (chooseDirectory) { var __dirname = dynamicDirectory(); }",
        'new NodejsFunction({}, "Worker", { entry: join(__dirname, "../runtime/handler.ts") });',
      ].join("\n"),
    ],
    [
      "local call shadow",
      [
        'import { join } from "node:path";',
        "function build() {",
        "  function join(...parts: string[]) { return parts[0] ?? ''; }",
        '  new NodejsFunction({}, "Worker", { entry: join(__dirname, "../runtime/handler.ts") });',
        "}",
      ].join("\n"),
    ],
    [
      "unrelated import",
      [
        'import { join } from "./string-tools.js";',
        'new NodejsFunction({}, "Worker", { entry: join(__dirname, "../runtime/handler.ts") });',
      ].join("\n"),
    ],
  ])("rejects an ambiguous CDK %s", (_name, source) => {
    const references = cdkNodejsFunctionReferences(
      "/repo",
      { dir: "/repo", rootRelDir: "", packageJson: null },
      [{ file: "infra/stack.ts", source }],
      new Set(["runtime/handler.ts"]),
    );
    expect(references).toEqual([]);
  });

  it("accepts an aliased helper proven to come from the Node path module", () => {
    const source = [
      'import { join as joinPath } from "path";',
      'new NodejsFunction({}, "Worker", {',
      '  entry: joinPath(__dirname, "../runtime/handler.ts"),',
      "});",
    ].join("\n");
    const references = cdkNodejsFunctionReferences(
      "/repo",
      { dir: "/repo", rootRelDir: "", packageJson: null },
      [{ file: "infra/stack.ts", source }],
      new Set(["runtime/handler.ts"]),
    );
    expect(references.map((reference) => reference.targetFile)).toEqual(["runtime/handler.ts"]);
  });

  it("resolves workflow command paths only from their effective working directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-workflow-directory-"));
    temporaryProjects.push(root);
    await Promise.all(
      [".github/workflows", "src", "scripts", "workspace"].map((dir) =>
        mkdir(join(root, dir), { recursive: true }),
      ),
    );
    await Promise.all([
      writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "workflow-directory", type: "module", main: "src/index.ts" }),
      ),
      writeFile(join(root, "src/index.ts"), "export const live = true;\n"),
      writeFile(join(root, "scripts/check.ts"), "export const check = true;\n"),
      writeFile(
        join(root, ".github/workflows/check.yml"),
        [
          "name: check",
          "on: push",
          "jobs:",
          "  check:",
          "    runs-on: ubuntu-latest",
          "    defaults:",
          "      run:",
          "        working-directory: workspace",
          "    steps:",
          "      - run: node scripts/check.ts",
          "",
        ].join("\n"),
      ),
    ]);
    const run = await analyzeProject(root, { now: FIXED_CLOCK });
    expect(
      fileClaims(run.claims).some((claim) => claim.subject.loc.file === "scripts/check.ts"),
    ).toBe(true);
  });

  it("roots only source paths occupying executable shell positions", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-shell-source-positions-"));
    temporaryProjects.push(root);
    await Promise.all(
      [".github/workflows", "src", "scripts", "load", "workspace/scripts"].map((dir) =>
        mkdir(join(root, dir), { recursive: true }),
      ),
    );
    const live = [
      "scripts/backtick-substitution.mjs",
      "scripts/direct-command.mjs",
      "scripts/dollar-substitution.mjs",
      "scripts/import-hook.mjs",
      "scripts/loader-hook.mjs",
      "scripts/node-options-entry.mjs",
      "scripts/require-hook.cjs",
      "scripts/workflow-entry.ts",
      "scripts/workflow-multiline.ts",
      "scripts/task-entry.ts",
      "load/smoke.js",
      "load/options.js",
      "workspace/scripts/env-entry.mjs",
    ];
    const dataOnly = [
      "bare-command.mjs",
      "scripts/copied-data.ts",
      "scripts/escaped-ampersand.ts",
      "scripts/escaped-pipe.ts",
      "scripts/escaped-semicolon.ts",
      "scripts/task-data.ts",
      "scripts/workflow-data.ts",
    ];
    await Promise.all([
      writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "shell-source-positions", type: "module", main: "src/index.ts" }),
      ),
      writeFile(join(root, "src/index.ts"), "export const live = true;\n"),
      ...[...live, ...dataOnly].map((file) =>
        writeFile(join(root, file), "export const sourcePosition = true;\n"),
      ),
      writeFile(
        join(root, ".github/workflows/check.yml"),
        [
          "name: check",
          "on: push",
          "jobs:",
          "  check:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: |",
          "          node scripts/workflow-entry.ts scripts/workflow-data.ts &&",
          "          node \\",
          "            scripts/workflow-multiline.ts",
          "          k6 run load/smoke.js",
          "          k6 run --vus 2 --duration=1s load/options.js",
          "          node -r./scripts/require-hook.cjs --import=./scripts/import-hook.mjs --loader=./scripts/loader-hook.mjs scripts/node-options-entry.mjs",
          "          env -u NODE_OPTIONS -C workspace node scripts/env-entry.mjs",
          '          echo "$(node scripts/dollar-substitution.mjs)"',
          '          echo "`node scripts/backtick-substitution.mjs`"',
          "          ./scripts/direct-command.mjs",
          "          bare-command.mjs",
          "          echo escaped\\;node scripts/escaped-semicolon.ts",
          "          echo escaped\\|node scripts/escaped-pipe.ts",
          "          echo escaped\\&node scripts/escaped-ampersand.ts",
          "          grep marker scripts/workflow-data.ts",
          "          cp scripts/copied-data.ts /tmp/copied-data.ts",
          "",
        ].join("\n"),
      ),
      writeFile(
        join(root, "Taskfile.yml"),
        [
          "version: '3'",
          "tasks:",
          "  check:",
          "    cmd: node scripts/task-entry.ts scripts/task-data.ts; grep marker scripts/task-data.ts",
          "",
        ].join("\n"),
      ),
    ]);
    await chmod(join(root, "scripts/direct-command.mjs"), 0o755);

    const run = await analyzeProject(root, { now: FIXED_CLOCK });
    const deadFiles = new Set(fileClaims(run.claims).map((claim) => claim.subject.loc.file));
    for (const file of live) expect(deadFiles.has(file), file).toBe(false);
    for (const file of dataOnly) expect(deadFiles.has(file), file).toBe(true);
  });

  it("does not guess roots for templated, expression, or escaping working directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-dynamic-directories-"));
    temporaryProjects.push(root);
    await Promise.all(
      [".github/workflows", "src", "scripts", "workspace/scripts"].map((dir) =>
        mkdir(join(root, dir), { recursive: true }),
      ),
    );
    const targets = [
      "scripts/workflow-expression.ts",
      "scripts/workflow-escape.ts",
      "scripts/task-template.ts",
      "scripts/task-escape.ts",
      "workspace/scripts/workflow-expression.ts",
      "workspace/scripts/task-template.ts",
    ];
    const workflowDirectoryExpression = ["$", "{{ matrix.directory }}"].join("");
    await Promise.all([
      writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "dynamic-directories", type: "module", main: "src/index.ts" }),
      ),
      writeFile(join(root, "src/index.ts"), "export const live = true;\n"),
      ...targets.map((target) =>
        writeFile(join(root, target), "export const sameNameControl = true;\n"),
      ),
      writeFile(
        join(root, ".github/workflows/check.yml"),
        [
          "name: check",
          "on: push",
          "jobs:",
          "  expression:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          `      - working-directory: ${workflowDirectoryExpression}`,
          "        run: node scripts/workflow-expression.ts",
          "  escape:",
          "    runs-on: ubuntu-latest",
          "    defaults:",
          "      run:",
          "        working-directory: ../outside",
          "    steps:",
          "      - run: node scripts/workflow-escape.ts",
          "",
        ].join("\n"),
      ),
      writeFile(
        join(root, "Taskfile.yml"),
        [
          "version: '3'",
          "tasks:",
          "  template:",
          "    dir: '{{.USER_WORKING_DIR}}'",
          "    cmd: node scripts/task-template.ts",
          "  escape:",
          "    dir: ../outside",
          "    cmd: node scripts/task-escape.ts",
          "",
        ].join("\n"),
      ),
    ]);

    const run = await analyzeProject(root, { now: FIXED_CLOCK });
    const deadFiles = new Set(fileClaims(run.claims).map((claim) => claim.subject.loc.file));
    for (const target of targets) expect(deadFiles.has(target), target).toBe(true);
  });

  it("follows only contained, static, non-ignored local Taskfile includes", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-taskfile-includes-"));
    temporaryProjects.push(root);
    await Promise.all(
      ["src", "scripts", "workspace/scripts", "tasks/directory"].map((dir) =>
        mkdir(join(root, dir), { recursive: true }),
      ),
    );
    const sourceFiles = [
      "scripts/directory.ts",
      "scripts/dynamic.ts",
      "scripts/good.ts",
      "scripts/ignored.ts",
      "workspace/scripts/dynamic.ts",
      "workspace/scripts/good.ts",
    ];
    await Promise.all([
      writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "taskfile-includes", type: "module", main: "src/index.ts" }),
      ),
      writeFile(join(root, ".gitignore"), "tasks/ignored.yml\n"),
      writeFile(join(root, "src/index.ts"), "export const live = true;\n"),
      ...sourceFiles.map((file) => writeFile(join(root, file), "export const control = true;\n")),
      writeFile(
        join(root, "Taskfile.yml"),
        [
          "version: '3'",
          "includes:",
          "  good:",
          "    taskfile: ./tasks/good.yml",
          "    dir: ./workspace",
          "  directory: ./tasks/directory",
          "  dynamic:",
          "    taskfile: ./tasks/dynamic.yml",
          "    dir: '{{.DIR}}'",
          "  ignored: ./tasks/ignored.yml",
          "  escape: ../outside.yml",
          "  remote: https://example.invalid/Taskfile.yml",
          "tasks:",
          "  default: echo ready",
          "",
        ].join("\n"),
      ),
      writeFile(
        join(root, "tasks/good.yml"),
        "version: '3'\nincludes:\n  cycle: ../Taskfile.yml\ntasks:\n  run:\n    cmd: node scripts/good.ts\n",
      ),
      writeFile(
        join(root, "tasks/dynamic.yml"),
        "version: '3'\ntasks:\n  run:\n    cmd: node scripts/dynamic.ts\n",
      ),
      writeFile(
        join(root, "tasks/ignored.yml"),
        "version: '3'\ntasks:\n  run:\n    cmd: node scripts/ignored.ts\n",
      ),
      writeFile(
        join(root, "tasks/directory/Taskfile.yml"),
        "version: '3'\ntasks:\n  run:\n    cmd: node scripts/directory.ts\n",
      ),
    ]);

    const normal = await analyzeProject(root, { now: FIXED_CLOCK });
    const normalDead = new Set(fileClaims(normal.claims).map((claim) => claim.subject.loc.file));
    expect(normalDead.has("workspace/scripts/good.ts")).toBe(false);
    expect(normalDead.has("scripts/directory.ts")).toBe(false);
    for (const control of [
      "scripts/dynamic.ts",
      "scripts/good.ts",
      "scripts/ignored.ts",
      "workspace/scripts/dynamic.ts",
    ]) {
      expect(normalDead.has(control), control).toBe(true);
    }

    const audited = await analyzeProject(root, { now: FIXED_CLOCK, gitignore: false });
    expect(
      fileClaims(audited.claims).some((claim) => claim.subject.loc.file === "scripts/ignored.ts"),
    ).toBe(false);
  });

  it("contains root-relative browser paths within their owning workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-browser-containment-"));
    temporaryProjects.push(root);
    await Promise.all(
      ["packages/app-a/src", "packages/app-b/src"].map((dir) =>
        mkdir(join(root, dir), { recursive: true }),
      ),
    );
    await Promise.all([
      writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "browser-containment", private: true, workspaces: ["packages/*"] }),
      ),
      writeFile(
        join(root, "packages/app-a/package.json"),
        JSON.stringify({ name: "app-a", type: "module", main: "src/index.ts" }),
      ),
      writeFile(
        join(root, "packages/app-a/src/index.ts"),
        [
          "export async function live(context: AudioContext) {",
          '  await context.audioWorklet.addModule("/../../app-b/src/target.ts");',
          "}",
          "",
        ].join("\n"),
      ),
      writeFile(
        join(root, "packages/app-a/index.html"),
        '<script type="module" src="/../app-b/src/target.ts"></script>\n',
      ),
      writeFile(
        join(root, "packages/app-b/package.json"),
        JSON.stringify({ name: "app-b", type: "module" }),
      ),
      writeFile(join(root, "packages/app-b/src/target.ts"), "export const target = true;\n"),
    ]);

    const run = await analyzeProject(root, { now: FIXED_CLOCK });
    expect(
      fileClaims(run.claims).some(
        (claim) => claim.subject.loc.file === "packages/app-b/src/target.ts",
      ),
    ).toBe(true);
  });

  it("ignores external carriers by default and restores them with --no-gitignore", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-ignored-carriers-"));
    temporaryProjects.push(root);
    await Promise.all(
      [".github/workflows", "src", "scripts"].map((dir) =>
        mkdir(join(root, dir), { recursive: true }),
      ),
    );
    await Promise.all([
      writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "ignored-carriers", type: "module", main: "src/index.ts" }),
      ),
      writeFile(join(root, ".gitignore"), "Taskfile.yml\n.github/workflows/ignored.yml\n"),
      writeFile(join(root, "src/index.ts"), "export const live = true;\n"),
      writeFile(join(root, "scripts/task.mjs"), "export const task = true;\n"),
      writeFile(join(root, "scripts/workflow.mjs"), "export const workflow = true;\n"),
      writeFile(
        join(root, "Taskfile.yml"),
        "version: '3'\ntasks:\n  run:\n    cmds:\n      - node scripts/task.mjs\n",
      ),
      writeFile(
        join(root, ".github/workflows/ignored.yml"),
        "name: ignored\non: push\njobs:\n  run:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node scripts/workflow.mjs\n",
      ),
    ]);

    const normal = await analyzeProject(root, { now: FIXED_CLOCK });
    const audited = await analyzeProject(root, { now: FIXED_CLOCK, gitignore: false });
    for (const file of ["scripts/task.mjs", "scripts/workflow.mjs"]) {
      expect(fileClaims(normal.claims).some((claim) => claim.subject.loc.file === file)).toBe(true);
      expect(fileClaims(audited.claims).some((claim) => claim.subject.loc.file === file)).toBe(
        false,
      );
    }
  });
});
