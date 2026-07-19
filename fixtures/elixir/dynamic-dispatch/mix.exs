defmodule Dyn.MixProject do
  use Mix.Project

  def project, do: [app: :dyn, version: "0.1.0", elixir: "~> 1.17"]
  def application, do: [mod: {Dyn.Application, []}]
end
