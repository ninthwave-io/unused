// Named to look like a production module, but reached ONLY via
// src/helper.ts, which itself is reached only from test/feature.test.ts. No
// production or config entrypoint references this file.
export function prodModuleFn(): number {
  return 42;
}
