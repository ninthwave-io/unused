defmodule NeutralLedgerCallerUse.Override do
  use NeutralLedgerCallerUse.Web, :entry

  def run(_raw), do: :original
  defoverridable run: 1
  def run(raw), do: NeutralLedgerCallerUse.Target.consume(String.to_atom(raw))
end
