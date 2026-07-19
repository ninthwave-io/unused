defmodule Tob.MixProject do
  use Mix.Project

  def project, do: [app: :tob, version: "0.1.0", elixir: "~> 1.17"]
  def application, do: [mod: {Tob.Application, []}]
end
