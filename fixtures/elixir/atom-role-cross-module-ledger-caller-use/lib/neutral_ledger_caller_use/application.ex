defmodule NeutralLedgerCallerUse.Application do
  use Application

  def start(_type, _args) do
    _ = NeutralLedgerCallerUse.Entry.run("known")
    _ = NeutralLedgerCallerUse.Override.run("known")
    _ = NeutralLedgerCallerUse.Generated.run("known")
    _ = NeutralLedgerCallerUse.Nested.run("known")
    {:ok, self()}
  end
end
