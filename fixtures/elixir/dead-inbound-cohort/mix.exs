defmodule NeutralDeadInbound.MixProject do
  use Mix.Project

  def project, do: [app: :neutral_dead_inbound, version: "0.1.0", elixir: "~> 1.17"]
  def application, do: [mod: {NeutralDeadInbound.Application, []}]
end
