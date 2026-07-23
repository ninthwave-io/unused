defmodule NeutralLedgerUse.Controller do
  use NeutralLedgerUse.Web, :controller

  def consume(value), do: Atom.to_string(value)
end
