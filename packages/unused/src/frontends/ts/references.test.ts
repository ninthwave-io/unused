/**
 * Value/type-position classification matrix (T2.1 acceptance) — the spike's
 * context-flip walk (criterion 1) completed into fixtures. Each case pins the
 * position (value vs type) of a reference to an imported binding.
 */
import { describe, expect, it } from "vitest";
import { parseSource } from "./parse.js";

/** All reference sites as `name:position`, sorted for stable comparison. */
function refs(src: string): string[] {
  return parseSource("case.ts", src)
    .references.map((r) => `${r.localName}:${r.position}`)
    .sort();
}

function refsTsx(src: string): string[] {
  return parseSource("case.tsx", src)
    .references.map((r) => `${r.localName}:${r.position}`)
    .sort();
}

describe("value/type-position classification", () => {
  it("type annotation is a TYPE reference", () => {
    expect(refs(`import { A } from './a.js';\nconst x: A = null as any;`)).toEqual(["A:type"]);
  });

  it("constructor call is a VALUE reference", () => {
    expect(refs(`import { A } from './a.js';\nconst x = new A();`)).toEqual(["A:value"]);
  });

  it("a binding used in both positions yields both sites", () => {
    expect(refs(`import { A } from './a.js';\nconst x: A = new A();`)).toEqual([
      "A:type",
      "A:value",
    ]);
  });

  it("class `extends X` references the VALUE (superClass, runtime)", () => {
    expect(refs(`import { Base } from './a.js';\nclass C extends Base {}`)).toEqual(["Base:value"]);
  });

  it("class `implements X` references the TYPE", () => {
    expect(refs(`import { Iface } from './a.js';\nclass C implements Iface {}`)).toEqual([
      "Iface:type",
    ]);
  });

  it("interface `extends X` references the TYPE", () => {
    expect(refs(`import { Base } from './a.js';\ninterface I extends Base {}`)).toEqual([
      "Base:type",
    ]);
  });

  it("`typeof X` inside a type references the VALUE", () => {
    expect(refs(`import { Val } from './a.js';\nconst t: typeof Val = null as any;`)).toEqual([
      "Val:value",
    ]);
  });

  it("inline `import { type X, y }` — X type-only usage, y value usage", () => {
    expect(refs(`import { type X, y } from './a.js';\nconst a: X = null as any;\ny();`)).toEqual([
      "X:type",
      "y:value",
    ]);
  });

  it("`as` operand is VALUE, `as` type is TYPE", () => {
    expect(refs(`import { V, T } from './a.js';\nconst x = V as T;`)).toEqual([
      "T:type",
      "V:value",
    ]);
  });

  it("`satisfies` operand is VALUE, satisfies type is TYPE", () => {
    expect(refs(`import { V, T } from './a.js';\nconst x = V satisfies T;`)).toEqual([
      "T:type",
      "V:value",
    ]);
  });

  it("generic type argument is a TYPE reference", () => {
    expect(refs(`import { T } from './a.js';\nconst m: Map<string, T> = new Map();`)).toEqual([
      "T:type",
    ]);
  });

  it("qualified type name `A.B` references the root A as a TYPE (property B skipped)", () => {
    expect(refs(`import { A, B } from './a.js';\nconst x: A.B = null as any;`)).toEqual(["A:type"]);
  });

  it("member access `obj.Prop` does not spuriously reference an import named Prop", () => {
    expect(refs(`import { Prop } from './a.js';\nconst v = obj.Prop;`)).toEqual([]);
  });

  it("decorator is a VALUE reference", () => {
    expect(refs(`import { Deco } from './a.js';\n@Deco\nclass C {}`)).toEqual(["Deco:value"]);
  });

  it("default parameter value is a VALUE reference", () => {
    expect(refs(`import { D } from './a.js';\nfunction f(x = D) { return x; }`)).toEqual([
      "D:value",
    ]);
  });

  it("JSX element name is a VALUE reference; attribute name is not", () => {
    // `bar` is a JSX attribute name (skipped); `Foo` and `Baz` are values.
    expect(
      refsTsx(`import { Foo, Baz, bar } from './a.js';\nconst el = <Foo bar={Baz} />;`),
    ).toEqual(["Baz:value", "Foo:value"]);
  });
});
