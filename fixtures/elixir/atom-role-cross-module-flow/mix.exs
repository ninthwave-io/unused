defmodule NeutralCrossFlow.MixProject do
  use Mix.Project

  def project, do: [app: :neutral_cross_flow, version: "0.1.0", elixir: "~> 1.17"]
  def application, do: [mod: {NeutralCrossFlow.Application, []}]
end
