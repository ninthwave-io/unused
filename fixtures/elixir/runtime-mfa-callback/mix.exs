defmodule NeutralMfa.MixProject do
  use Mix.Project

  def project, do: [app: :neutral_mfa, version: "0.1.0", elixir: "~> 1.17"]
  def application, do: [mod: {NeutralMfa.Application, []}]
end
