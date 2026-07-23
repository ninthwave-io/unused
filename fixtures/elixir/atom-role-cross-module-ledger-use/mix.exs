defmodule NeutralLedgerUse.MixProject do
  use Mix.Project

  def project, do: [app: :neutral_ledger_use, version: "0.1.0", elixir: "~> 1.17"]
  def application, do: [mod: {NeutralLedgerUse.Application, []}]
end
