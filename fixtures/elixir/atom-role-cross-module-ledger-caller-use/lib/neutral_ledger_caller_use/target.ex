defmodule NeutralLedgerCallerUse.Target do
  def consume(value), do: Atom.to_string(value)
end
