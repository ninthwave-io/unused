defmodule NeutralAtomData.MixProject do
  use Mix.Project

  def project, do: [app: :neutral_atom_data_role, version: "0.1.0", elixir: "~> 1.17"]
  def application, do: [mod: {NeutralAtomData.Application, []}]
end
