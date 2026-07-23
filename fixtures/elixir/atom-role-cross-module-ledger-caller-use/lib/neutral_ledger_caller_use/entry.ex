defmodule NeutralLedgerCallerUse.Entry do
  use NeutralLedgerCallerUse.Web, :entry

  def run(raw), do: NeutralLedgerCallerUse.Target.consume(String.to_atom(raw))
  def genuinely_unused, do: :unused
end
