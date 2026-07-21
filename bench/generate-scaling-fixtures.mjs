#!/usr/bin/env node
/**
 * Generate neutral, deterministic TS/JS scaling fixtures for the analyzer.
 *
 * The generated projects are original synthetic code. They deliberately mix
 * multiple workspaces, broad import fan-out, many exports, test roots, literal
 * and computed dynamic imports, config roots, and a bounded dead-code region.
 * Generated files are benchmark artifacts and are never committed.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_OUT = join(tmpdir(), "unused-scaling-fixtures");
const DEFAULT_SIZES = [250, 500, 1000, 2000, 3000];
const WORKSPACE_COUNT = 4;
const CHAINED_EXPORTS_PER_FILE = 24;
const INDEPENDENT_EXPORTS_PER_FILE = 8;
const EXPORTS_PER_FILE = CHAINED_EXPORTS_PER_FILE + INDEPENDENT_EXPORTS_PER_FILE;
const DEAD_FRACTION = 0.12;

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT, sizes: DEFAULT_SIZES, ignoredJson: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") {
      args.out = resolve(argv[index + 1]);
      index += 1;
    } else if (arg === "--sizes") {
      args.sizes = argv[index + 1]
        .split(",")
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isInteger(value) && value >= 40);
      index += 1;
    } else if (arg === "--ignored-json") {
      args.ignoredJson = Number.parseInt(argv[index + 1], 10);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: node bench/generate-scaling-fixtures.mjs [--out DIR] [--sizes 250,500,...] [--ignored-json N]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (args.sizes.length === 0) throw new Error("--sizes must contain at least one size >= 40");
  if (!Number.isInteger(args.ignoredJson) || args.ignoredJson < 0) {
    throw new Error("--ignored-json must be a non-negative integer");
  }
  return args;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function exportedBody(workspace, ordinal) {
  const lines = [];
  for (let index = 0; index < CHAINED_EXPORTS_PER_FILE; index += 1) {
    const expression =
      index + 1 < CHAINED_EXPORTS_PER_FILE
        ? `value${index + 1}(input) + ${workspace * 100_000 + ordinal * 100 + index}`
        : `input + ${workspace * 100_000 + ordinal * 100 + index}`;
    lines.push(`export function value${index}(input: number): number { return ${expression}; }`);
  }
  for (let index = 0; index < INDEPENDENT_EXPORTS_PER_FILE; index += 1) {
    lines.push(
      `export function candidate${index}(input: number): number { return input - ${workspace * 100_000 + ordinal * 100 + index}; }`,
    );
  }
  return lines.join("\n");
}

function moduleSource({ workspace, ordinal, imports, dynamicTarget, computedDynamic }) {
  const lines = [];
  for (const target of imports) {
    lines.push(`import { value0 as next${target} } from "./module-${target}.js";`);
  }
  if (dynamicTarget !== null) {
    lines.push(`export const lazy${ordinal} = () => import("./module-${dynamicTarget}.js");`);
  }
  if (computedDynamic) {
    lines.push(
      `export const select${ordinal} = (name: string) => import(\`./plugins/\${name}.js\`);`,
    );
  }
  lines.push(exportedBody(workspace, ordinal));
  if (imports.length > 0) {
    lines.push(
      `export const fanout${ordinal} = ${imports.map((target) => `next${target}(${ordinal})`).join(" + ")};`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function generateFixture(outRoot, fileCount, ignoredJson) {
  const root = join(outRoot, `files-${fileCount}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "packages"), { recursive: true });
  writeJson(join(root, "package.json"), {
    name: `neutral-scaling-${fileCount}`,
    private: true,
    workspaces: ["packages/*"],
  });
  if (ignoredJson > 0) {
    writeFileSync(join(root, ".gitignore"), "generated-cache/\n");
    for (let index = 0; index < ignoredJson; index += 1) {
      const directory = join(
        root,
        "generated-cache",
        `shard-${String(index % 100).padStart(3, "0")}`,
        `entry-${String(index).padStart(6, "0")}`,
      );
      mkdirSync(directory, { recursive: true });
      writeJson(join(directory, "metadata.json"), {
        neutral: `generated-${index}`,
        references: Array.from({ length: 12 }, (_, value) => `artifact-${index}-${value}`),
      });
    }
  }

  const base = Math.floor(fileCount / WORKSPACE_COUNT);
  let remainder = fileCount % WORKSPACE_COUNT;
  let generated = 0;
  const counters = { tests: 0, dead: 0, dynamicImports: 0, computedImports: 0, exports: 0 };

  for (let workspace = 0; workspace < WORKSPACE_COUNT; workspace += 1) {
    const count = base + (remainder > 0 ? 1 : 0);
    remainder -= remainder > 0 ? 1 : 0;
    const unit = join(root, "packages", `unit-${workspace}`);
    const sourceDir = join(unit, "src");
    mkdirSync(join(sourceDir, "plugins"), { recursive: true });
    writeJson(join(unit, "package.json"), {
      name: `@neutral/unit-${workspace}`,
      type: "module",
      exports: "./src/index.ts",
    });
    writeJson(join(unit, "tsconfig.json"), {
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2023" },
      include: ["src", "vite.config.ts"],
    });

    // Two convention/config roots per unit. They count toward the requested
    // source-file total and keep a small helper chain alive.
    writeFileSync(
      join(unit, "vite.config.ts"),
      'import { value0 } from "./src/module-1.js";\nexport default { neutral: value0(1) };\n',
    );
    writeFileSync(
      join(sourceDir, "index.ts"),
      'export { value0 as start } from "./module-1.js";\n',
    );
    generated += 2;
    counters.exports += 1;

    const moduleSlots = count - 2;
    const deadStart = Math.max(2, Math.floor(moduleSlots * (1 - DEAD_FRACTION)));
    for (let ordinal = 1; ordinal <= moduleSlots; ordinal += 1) {
      const isTest = ordinal % 10 === 0 && ordinal < deadStart;
      const isDead = ordinal >= deadStart;
      let file;
      let source;
      if (isTest) {
        const target = Math.max(1, ordinal - 7);
        file = join(sourceDir, `case-${ordinal}.test.ts`);
        source =
          `import { value0 } from "./module-${target}.js";\n` +
          `export const observed = value0(${ordinal});\n`;
        counters.tests += 1;
        counters.exports += 1;
      } else {
        file = join(sourceDir, `module-${ordinal}.ts`);
        const regionEnd = isDead ? moduleSlots : deadStart - 1;
        const imports = [];
        for (let distance = 1; distance <= 3; distance += 1) {
          const target = ordinal + distance;
          if (target <= regionEnd && target % 10 !== 0) imports.push(target);
        }
        const dynamicTarget = ordinal % 37 === 0 && imports[0] !== undefined ? imports[0] : null;
        const computedDynamic = ordinal % 211 === 0;
        source = moduleSource({ workspace, ordinal, imports, dynamicTarget, computedDynamic });
        counters.dead += isDead ? 1 : 0;
        counters.dynamicImports += dynamicTarget === null ? 0 : 1;
        counters.computedImports += computedDynamic ? 1 : 0;
        counters.exports +=
          EXPORTS_PER_FILE + 1 + (dynamicTarget === null ? 0 : 1) + (computedDynamic ? 1 : 0);
      }
      writeFileSync(file, source);
      generated += 1;
    }
  }

  if (generated !== fileCount) {
    throw new Error(`fixture ${fileCount}: generated ${generated} source files`);
  }
  writeJson(join(root, "fixture-metadata.json"), {
    sourceFiles: generated,
    workspaces: WORKSPACE_COUNT,
    exportsPerModule: EXPORTS_PER_FILE,
    chainedExportsPerModule: CHAINED_EXPORTS_PER_FILE,
    independentExportsPerModule: INDEPENDENT_EXPORTS_PER_FILE,
    ...counters,
    ignoredJson,
  });
  return { root, sourceFiles: generated, workspaces: WORKSPACE_COUNT, ignoredJson, ...counters };
}

const args = parseArgs(process.argv.slice(2));
mkdirSync(args.out, { recursive: true });
const fixtures = args.sizes.map((size) => generateFixture(args.out, size, args.ignoredJson));
process.stdout.write(
  `${JSON.stringify({ generator: fileURLToPath(import.meta.url), fixtures }, null, 2)}\n`,
);
