import { describe, expect, it } from "vitest";
import { globToRegExp } from "./glob.js";

describe("globToRegExp", () => {
  it("`*` matches within one path segment only", () => {
    const re = globToRegExp("src/*.ts");
    expect(re.test("src/index.ts")).toBe(true);
    expect(re.test("src/sub/index.ts")).toBe(false);
  });

  it("`**` matches any depth, including zero", () => {
    const re = globToRegExp("src/**/*.ts");
    expect(re.test("src/index.ts")).toBe(true); // `**/` also matches the dir itself
    expect(re.test("src/a/b/c.ts")).toBe(true);
    expect(re.test("lib/index.ts")).toBe(false);
  });

  it("a bare `**` prefix matches any depth", () => {
    const re = globToRegExp("**/dist/**");
    expect(re.test("dist/x.js")).toBe(true);
    expect(re.test("packages/app/dist/x.js")).toBe(true);
    expect(re.test("packages/app/build/x.js")).toBe(false);
  });

  it("brace alternation expands to alternatives (PRD §6 worked example)", () => {
    const re = globToRegExp("src/**/*.{ts,tsx}");
    expect(re.test("src/app.ts")).toBe(true);
    expect(re.test("src/app.tsx")).toBe(true);
    expect(re.test("src/nested/app.tsx")).toBe(true);
    expect(re.test("src/app.js")).toBe(false);
  });

  it("brace alternatives may themselves contain wildcards", () => {
    const re = globToRegExp("{src,lib}/**/*.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("lib/a.ts")).toBe(true);
    expect(re.test("other/a.ts")).toBe(false);
  });

  it("an unmatched `{` is treated as a literal character", () => {
    const re = globToRegExp("weird{file.ts");
    expect(re.test("weird{file.ts")).toBe(true);
  });

  it("regex metacharacters outside wildcards are escaped (literal match)", () => {
    const re = globToRegExp("src/a+b.ts");
    expect(re.test("src/a+b.ts")).toBe(true);
    expect(re.test("src/aXb.ts")).toBe(false);
  });

  it("strips a leading `./` and trailing slashes before compiling", () => {
    const re = globToRegExp("./packages/**/");
    expect(re.test("packages/app")).toBe(true);
  });

  it("is fully anchored — never matches a substring", () => {
    const re = globToRegExp("*.ts");
    expect(re.test("index.ts")).toBe(true);
    expect(re.test("index.ts.map")).toBe(false);
    expect(re.test("src/index.ts")).toBe(false);
  });
});
