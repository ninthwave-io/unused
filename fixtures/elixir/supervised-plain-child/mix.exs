defmodule PlainSup.MixProject do
  use Mix.Project

  def project, do: [app: :plainsup, version: "0.1.0", elixir: "~> 1.17"]
  def application, do: [mod: {PlainSup.Application, []}]
end
