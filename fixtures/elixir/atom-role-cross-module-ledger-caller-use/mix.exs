defmodule NeutralLedgerCallerUse.MixProject do
  use Mix.Project

  def project, do: [app: :neutral_ledger_caller_use, version: "0.1.0", elixir: "~> 1.17"]
  def application, do: [mod: {NeutralLedgerCallerUse.Application, []}]
end
