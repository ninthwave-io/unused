// Self-contained ambient declaration so this fixture does not depend on @types/node
// (mirrors the `declare const require` pattern in ../require-expression/src/index.ts).
declare const module: { exports: Record<string, unknown> };

// A normal named export, statically imported by the entry below — a real,
// unambiguous consumer.
export function staticHandler(): string {
  return "static";
}

// Also a declared named export, but nothing anywhere statically imports it
// by name.
export function dynamicHandler(): string {
  return "dynamic";
}

const registry: Record<string, () => string> = { dynamicHandler };

// Computed CJS export: the property key assigned onto `module.exports` is a
// loop variable, not a string literal, so static analysis cannot prove
// whether `dynamicHandler` (or any other entry a future maintainer adds to
// `registry`) is re-exposed on `module.exports` under some other runtime
// key — the "computed CJS exports (`module.exports[k]`)" hazard,
// architecture §4. `staticHandler` is untouched by this loop, so its own
// liveness is unaffected by the hazard.
for (const key of Object.keys(registry)) {
  module.exports[key] = registry[key];
}
