defmodule NeutralLocal.MixProject do
  use Mix.Project

  def project, do: [app: :neutral_local, version: "0.1.0", elixir: "~> 1.17"]
  def application, do: [mod: {NeutralLocal.Application, []}]
end
