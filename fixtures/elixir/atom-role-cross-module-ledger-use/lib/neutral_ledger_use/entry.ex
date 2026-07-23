defmodule NeutralLedgerUse.Entry do
  def run(raw), do: NeutralLedgerUse.Controller.consume(String.to_atom(raw))
  def genuinely_unused, do: :unused
end
