import { describe, expect, it } from "vitest";
import { extractRustlerRustSource } from "./rustler.js";

describe("extractRustlerRustSource", () => {
  it("extracts literal registration and NIF names, arities, and source lines", () => {
    const result = extractRustlerRustSource(
      "native/neutral/src/lib.rs",
      `use rustler::Env;

#[rustler::nif]
fn combine(left: i64, right: Option<(i64, i64)>) -> i64 { left }

#[rustler::nif(schedule = "DirtyCpu")]
pub fn inspect_env(env: Env, values: Vec<(i64, i64)>) -> usize { values.len() }

rustler::init!("Elixir.Neutral.Native");
`,
    );

    expect(result.registrations).toMatchObject([
      { module: "Neutral.Native", site: { span: { startLine: 9 } } },
    ]);
    expect(result.nifs).toMatchObject([
      { name: "combine", arity: 2, site: { span: { startLine: 3 } } },
      { name: "inspect_env", arity: 2, site: { span: { startLine: 6 } } },
    ]);
    expect(result.ambiguousSites).toEqual([]);
  });

  it("ignores commented examples and reports computed or unsupported forms", () => {
    const result = extractRustlerRustSource(
      "src/lib.rs",
      `// #[rustler::nif]
// fn example() {}
#[rustler::nif(name = "renamed")]
fn original(value: i64) -> i64 { value }
rustler::init!(module_name());
`,
    );

    expect(result.nifs).toEqual([]);
    expect(result.registrations).toEqual([]);
    expect(result.ambiguousSites.map((site) => site.span.startLine)).toEqual([3, 5]);
  });
});
