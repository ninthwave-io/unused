import { describe, expect, it } from "vitest";
import { extractElixirRustlerSource } from "./rustler.js";

describe("extractElixirRustlerSource", () => {
  it("extracts a literal loader and generated-style stubs", () => {
    const result = extractElixirRustlerSource(
      "lib/neutral/native.ex",
      `defmodule Neutral.Native do
  use Rustler,
    otp_app: :neutral,
    crate: :neutral_native

  def combine(left, right), do: :erlang.nif_error(:nif_not_loaded)

  def inspect_env(
        context,
        %{values: values}
      ), do: :erlang.nif_error(:nif_not_loaded)

  def ordinary(value), do: value
end
`,
    );

    expect(result.modules).toMatchObject([
      {
        module: "Neutral.Native",
        otpApp: "neutral",
        crate: "neutral_native",
        site: { span: { startLine: 2 } },
        stubs: [
          { name: "combine", arity: 2, site: { span: { startLine: 6 } } },
          { name: "inspect_env", arity: 2, site: { span: { startLine: 8 } } },
        ],
      },
    ]);
    expect(result.ambiguousSites).toEqual([]);
  });

  it("marks a loader without one literal OTP application as ambiguous", () => {
    const result = extractElixirRustlerSource(
      "lib/neutral.ex",
      `defmodule Neutral.Native do
  use Rustler, otp_app: configured_app()
  def call(), do: :erlang.nif_error(:nif_not_loaded)
end
`,
    );

    expect(result.modules).toMatchObject([{ module: "Neutral.Native" }]);
    expect(result.modules[0]).not.toHaveProperty("otpApp");
    expect(result.ambiguousSites).toMatchObject([{ span: { startLine: 2 } }]);
  });

  it("does not treat comments or ordinary functions as Rustler stubs", () => {
    const result = extractElixirRustlerSource(
      "lib/neutral.ex",
      `# use Rustler, otp_app: :example
defmodule Neutral do
  def ordinary(value), do: value
end
`,
    );
    expect(result.modules).toEqual([]);
    expect(result.ambiguousSites).toEqual([]);
  });
});
