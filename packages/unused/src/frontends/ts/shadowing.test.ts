/**
 * Shadowing correctness (T2.1 acceptance) — the spike's named #1 false-positive
 * risk (spike §caveat 1). A local declaration that shadows an imported name
 * means an occurrence of that name is NOT a reference to the import. Dropping a
 * *real* reference would be a false "unused" (the enemy), so these must hold.
 *
 * ≥8 cases, including type-parameter and catch-param shadowing, plus the
 * namespace-separation case (a value binding does not shadow a type use).
 */
import { describe, expect, it } from "vitest";
import { parseSource } from "./parse.js";

function refs(src: string): string[] {
  return parseSource("case.ts", src)
    .references.map((r) => `${r.localName}:${r.position}`)
    .sort();
}

describe("shadowing", () => {
  it("1. function parameter shadows a value import", () => {
    expect(refs(`import { W } from './a.js';\nfunction f(W) { return W; }`)).toEqual([]);
  });

  it("2. block-scoped const shadows a value import", () => {
    expect(refs(`import { W } from './a.js';\n{ const W = 1; W.toString(); }`)).toEqual([]);
  });

  it("3. catch parameter shadows a value import", () => {
    expect(refs(`import { e } from './a.js';\ntry { throw 0; } catch (e) { e; }`)).toEqual([]);
  });

  it("4. type parameter shadows a type-only import", () => {
    expect(refs(`import type { T } from './a.js';\nfunction f<T>(x: T): T { return x; }`)).toEqual(
      [],
    );
  });

  it("5. type parameter shadows locally, but the outer type use is a real reference", () => {
    expect(
      refs(
        `import type { T } from './a.js';\nconst outer: T = null as any;\nfunction f<T>(x: T) { return x; }`,
      ),
    ).toEqual(["T:type"]);
  });

  it("6. a block-scoped function declaration shadows a value import", () => {
    expect(
      refs(
        `import { helper } from './a.js';\nfunction outer() {\n  function helper() { return 1; }\n  return helper();\n}`,
      ),
    ).toEqual([]);
  });

  it("7. class type parameter shadows a type import", () => {
    expect(refs(`import type { T } from './a.js';\nclass C<T> { x!: T; }`)).toEqual([]);
  });

  it("8. an inner shadow does not suppress the module-scope reference", () => {
    expect(
      refs(`import { W } from './a.js';\nnew W();\nfunction f() { const W = 2; return W; }`),
    ).toEqual(["W:value"]);
  });

  it("9. namespace separation: a value `const T` shadows value uses but NOT the type use", () => {
    expect(
      refs(
        `import type { T } from './a.js';\nfunction f() {\n  const T = 1;\n  const x: T = null as any;\n  return T + (x ? 1 : 0);\n}`,
      ),
    ).toEqual(["T:type"]);
  });

  it("10. arrow-function parameter shadows a value import", () => {
    expect(refs(`import { x } from './a.js';\nconst f = (x) => x;`)).toEqual([]);
  });

  it("11. destructuring parameter shadows a value import", () => {
    expect(refs(`import { a } from './a.js';\nfunction f({ a }) { return a; }`)).toEqual([]);
  });
});
