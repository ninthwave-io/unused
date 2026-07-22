defmodule NeutralGlobal.MixProject do
  use Mix.Project

  def project, do: [app: :neutral_global, version: "0.1.0", elixir: "~> 1.17"]
  def application, do: [mod: {NeutralGlobal.Application, []}]
end
