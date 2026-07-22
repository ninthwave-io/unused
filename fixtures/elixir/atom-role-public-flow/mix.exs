defmodule NeutralPublicFlow.MixProject do
  use Mix.Project

  def project, do: [app: :neutral_public_flow, version: "0.1.0", elixir: "~> 1.17"]
  def application, do: [mod: {NeutralPublicFlow.Application, []}]
end
