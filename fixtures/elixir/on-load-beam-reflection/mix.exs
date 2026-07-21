defmodule NeutralOnLoad.MixProject do
  use Mix.Project

  def project, do: [app: :neutral_on_load, version: "0.1.0", elixir: "~> 1.17"]
  def application, do: [mod: {NeutralOnLoad.Application, []}]
end
