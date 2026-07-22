defmodule NeutralAtomFlow.MixProject do
  use Mix.Project

  def project, do: [app: :neutral_atom_flow, version: "0.1.0", elixir: "~> 1.17"]
  def application, do: [mod: {NeutralAtomFlow.Application, []}]
end
