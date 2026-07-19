defmodule SupTree.MixProject do
  use Mix.Project

  def project, do: [app: :sup_tree, version: "0.1.0", elixir: "~> 1.17"]
  def application, do: [mod: {SupTree.Application, []}]
end
