import { describe, expect, it } from "vitest";
import { stripJsonComments } from "./jsonc.js";

function parse(source: string): unknown {
  return JSON.parse(stripJsonComments(source));
}

describe("stripJsonComments", () => {
  it("passes strict JSON through unchanged in meaning", () => {
    expect(parse('{"a": 1, "b": [1, 2, 3]}')).toEqual({ a: 1, b: [1, 2, 3] });
  });

  it("strips a line comment", () => {
    expect(parse('{\n  "a": 1 // trailing comment\n}')).toEqual({ a: 1 });
  });

  it("strips a full-line comment", () => {
    expect(parse('{\n  // a leading comment\n  "a": 1\n}')).toEqual({ a: 1 });
  });

  it("strips a block comment", () => {
    expect(parse('{ "a": /* inline */ 1 }')).toEqual({ a: 1 });
  });

  it("strips a multi-line block comment", () => {
    expect(parse('{\n  /* line one\n     line two */\n  "a": 1\n}')).toEqual({ a: 1 });
  });

  it("strips a trailing comma in an object", () => {
    expect(parse('{ "a": 1, "b": 2, }')).toEqual({ a: 1, b: 2 });
  });

  it("strips a trailing comma in an array", () => {
    expect(parse('{ "a": [1, 2, 3,] }')).toEqual({ a: [1, 2, 3] });
  });

  it("strips a trailing comma separated from the bracket by whitespace/newlines", () => {
    expect(parse('{\n  "a": 1,\n}\n')).toEqual({ a: 1 });
  });

  it("never touches a `//` that appears inside a string value", () => {
    expect(parse('{ "url": "https://example.com" }')).toEqual({ url: "https://example.com" });
  });

  it("never touches a `/*` that appears inside a string value", () => {
    expect(parse('{ "note": "a /* not a comment */ literal" }')).toEqual({
      note: "a /* not a comment */ literal",
    });
  });

  it("never touches a comma inside a string value", () => {
    expect(parse('{ "note": "a, b, c" }')).toEqual({ note: "a, b, c" });
  });

  it("respects an escaped quote inside a string when scanning for comments", () => {
    // The string `a \" // not a comment` contains an escaped quote followed by
    // `//` — the escaped quote must not be read as the string's terminator,
    // or the scanner would fall out of string mode and strip the `//` body.
    expect(parse('{ "a": "x \\" // y" }')).toEqual({ a: 'x " // y' });
  });

  it("handles the PRD §6 worked example verbatim", () => {
    const source = `// unused.config.jsonc
{
  // Next.js preset seeds file-based route entrypoints; these add to it.
  "entry": ["src/index.ts", "src/pages/**/*.tsx"],
  "project": ["src/**/*.{ts,tsx}"],
  "ignore": ["**/*.generated.ts", "src/legacy/**"],
  "ignoreDependencies": ["@types/node"],
  "workspaces": {
    "packages/api": {
      "entry": ["src/server.ts"]
    }
  },
  "gate": {
    "threshold": "medium"
  }
}
`;
    expect(parse(source)).toEqual({
      entry: ["src/index.ts", "src/pages/**/*.tsx"],
      project: ["src/**/*.{ts,tsx}"],
      ignore: ["**/*.generated.ts", "src/legacy/**"],
      ignoreDependencies: ["@types/node"],
      workspaces: { "packages/api": { entry: ["src/server.ts"] } },
      gate: { threshold: "medium" },
    });
  });

  it("a genuinely malformed input still fails JSON.parse (this module only removes JSONC extensions)", () => {
    expect(() => parse('{ "a": 1 "b": 2 }')).toThrow();
  });

  it("preserves line numbers across a stripped block comment (parse-error positions stay meaningful)", () => {
    const source = '{\n  /* line one\n     line two */\n  "a": 1 "b": 2\n}';
    const stripped = stripJsonComments(source);
    expect(stripped.split("\n")).toHaveLength(source.split("\n").length);
  });
});
