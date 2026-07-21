defmodule NeutralSupport.MixProject do
  use Mix.Project

  def project do
    [
      app: :neutral_support,
      version: "0.1.0",
      elixir: "~> 1.17",
      elixirc_paths: elixirc_paths(Mix.env())
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support", "test/custom_helpers"]
  defp elixirc_paths(_), do: ["lib"]
end
