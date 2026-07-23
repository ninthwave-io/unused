defmodule NeutralLedgerUse.Application do
  use Application

  def start(_type, _args) do
    _ = NeutralLedgerUse.Entry.run("known")
    {:ok, self()}
  end
end
