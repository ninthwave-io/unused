#!/usr/bin/env node
/**
 * Generate neutral, deterministic TS/JS scaling fixtures for the analyzer.
 *
 * The generated projects are original synthetic code. They deliberately mix
 * multiple workspaces, broad import fan-out, many exports, test roots, literal
 * and computed dynamic imports, config roots, and a bounded dead-code region.
 * Generated files are benchmark artifacts and are never committed.
 */

import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  const args = { out: DEFAULT_OUT, sizes: DEFAULT_SIZES, ignoredJson: 0, variants: false };
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
    } else if (arg === "--variants") {
      args.variants = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: node bench/generate-scaling-fixtures.mjs [--out DIR] [--sizes 250,500,...] [--ignored-json N] [--variants]\n",
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

function addNeutralRustBoundary(root) {
  mkdirSync(join(root, "rust-src"), { recursive: true });
  writeFileSync(
    join(root, "Cargo.toml"),
    '[package]\nname = "neutral-scaling-boundary"\nversion = "0.0.0"\nedition = "2024"\n\n[lib]\npath = "rust-src/lib.rs"\n',
  );
  writeFileSync(
    join(root, "Cargo.lock"),
    '# This file is automatically @generated by Cargo.\nversion = 4\n\n[[package]]\nname = "neutral-scaling-boundary"\nversion = "0.0.0"\n',
  );
  writeFileSync(join(root, "rust-src", "lib.rs"), "pub fn neutral_entry() -> usize { 1 }\n");
}

function generateManyBoundaryFixture(outRoot, fileCount) {
  const root = join(outRoot, `many-boundary-files-${fileCount}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "boundaries"), { recursive: true });
  const boundaryCount = Math.min(32, Math.max(4, Math.floor(fileCount / 50)));
  const base = Math.floor(fileCount / boundaryCount);
  let remainder = fileCount % boundaryCount;
  let generated = 0;
  const counters = { tests: 0, configRoots: 0, dynamicImports: 0, computedImports: 0 };
  for (let boundary = 0; boundary < boundaryCount; boundary += 1) {
    const count = base + (remainder > 0 ? 1 : 0);
    remainder -= remainder > 0 ? 1 : 0;
    const unit = join(root, "boundaries", `unit-${boundary}`);
    const sourceDir = join(unit, "src");
    mkdirSync(join(sourceDir, "plugins"), { recursive: true });
    writeJson(join(unit, "package.json"), {
      name: `@neutral/boundary-${boundary}`,
      type: "module",
      main: "src/index.ts",
    });
    writeJson(join(unit, "tsconfig.json"), {
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2023" },
      include: ["src", "vite.config.ts"],
    });
    writeFileSync(
      join(sourceDir, "index.ts"),
      'import { value0, select1 } from "./module-1.js";\n' +
        'export const start = value0(1);\nexport const lazy = select1("neutral");\n',
    );
    writeFileSync(
      join(unit, "vite.config.ts"),
      'import { value0 } from "./src/module-2.js";\nexport default { neutral: value0(2) };\n',
    );
    counters.configRoots += 1;
    generated += 2;
    const moduleCount = count - 2;
    const deadStart = Math.max(2, Math.floor(moduleCount * (1 - DEAD_FRACTION)));
    for (let ordinal = 1; ordinal <= moduleCount; ordinal += 1) {
      const isTest = ordinal % 10 === 0 && ordinal < deadStart;
      const isDead = ordinal >= deadStart;
      const next = ordinal + 1;
      const imports =
        next <= (isDead ? moduleCount : deadStart - 1) && next % 10 !== 0 ? [next] : [];
      if (isTest) {
        const target = Math.max(1, ordinal - 7);
        writeFileSync(
          join(sourceDir, `case-${ordinal}.test.ts`),
          `import { value0 } from "./module-${target}.js";\n` +
            `export const observed = value0(${ordinal});\n`,
        );
        counters.tests += 1;
        generated += 1;
        continue;
      }
      const dynamicTarget = ordinal % 37 === 0 && imports[0] !== undefined ? imports[0] : null;
      // One reachable computed-import carrier per boundary keeps hazard/fixed-
      // point density stable even when each boundary is smaller than 211 files.
      const computedDynamic = ordinal === 1;
      writeFileSync(
        join(sourceDir, `module-${ordinal}.ts`),
        moduleSource({
          workspace: boundary,
          ordinal,
          imports,
          dynamicTarget,
          computedDynamic,
        }),
      );
      counters.dynamicImports += dynamicTarget === null ? 0 : 1;
      counters.computedImports += computedDynamic ? 1 : 0;
      generated += 1;
    }
  }
  if (generated !== fileCount) {
    throw new Error(`many-boundary fixture ${fileCount}: generated ${generated} source files`);
  }
  writeJson(join(root, "fixture-metadata.json"), {
    sourceFiles: generated,
    boundaries: boundaryCount,
    exportsPerModule: EXPORTS_PER_FILE,
    deadFraction: DEAD_FRACTION,
    ...counters,
  });
  if (counters.computedImports !== boundaryCount || counters.tests === 0) {
    throw new Error(`many-boundary fixture ${fileCount}: required hazard/test density was lost`);
  }
  return {
    root,
    sourceFiles: generated,
    workspaces: boundaryCount,
    variant: "many-boundary",
    rustSourceFiles: 0,
    ...counters,
  };
}

function generateVariants(outRoot, direct) {
  const rootMixed = join(outRoot, `root-mixed-files-${direct.sourceFiles}`);
  rmSync(rootMixed, { recursive: true, force: true });
  cpSync(direct.root, rootMixed, { recursive: true });
  addNeutralRustBoundary(rootMixed);

  const nestedMixed = join(outRoot, `nested-mixed-files-${direct.sourceFiles}`);
  rmSync(nestedMixed, { recursive: true, force: true });
  mkdirSync(nestedMixed, { recursive: true });
  cpSync(direct.root, join(nestedMixed, "typescript"), { recursive: true });
  addNeutralRustBoundary(nestedMixed);
  return [
    { ...direct, root: rootMixed, variant: "root-mixed", rustSourceFiles: 1 },
    { ...direct, root: nestedMixed, variant: "nested-mixed", rustSourceFiles: 1 },
    generateManyBoundaryFixture(outRoot, direct.sourceFiles),
  ];
}

const args = parseArgs(process.argv.slice(2));
mkdirSync(args.out, { recursive: true });
const direct = args.sizes.map((size) => ({
  ...generateFixture(args.out, size, args.ignoredJson),
  variant: "direct",
  rustSourceFiles: 0,
}));
const fixtures = args.variants
  ? direct.flatMap((fixture) => [fixture, ...generateVariants(args.out, fixture)])
  : direct;
const fixtureRoots = new Set(fixtures.map((fixture) => fixture.root));
if (fixtureRoots.size !== fixtures.length) {
  throw new Error("generated fixture roots must be unique");
}
process.stdout.write(
  `${JSON.stringify({ generator: fileURLToPath(import.meta.url), fixtures }, null, 2)}\n`,
);
