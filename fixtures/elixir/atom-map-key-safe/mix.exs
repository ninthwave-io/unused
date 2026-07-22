defmodule NeutralAtomKey.MixProject do
  use Mix.Project

  def project, do: [app: :neutral_atom_key, version: "0.1.0", elixir: "~> 1.17"]
  def application, do: [mod: {NeutralAtomKey.Application, []}]
end
