defmodule BasicDead.MixProject do
  use Mix.Project

  def project, do: [app: :basic_dead, version: "0.1.0", elixir: "~> 1.17"]
  def application, do: [mod: {BasicDead.Application, []}]
end
