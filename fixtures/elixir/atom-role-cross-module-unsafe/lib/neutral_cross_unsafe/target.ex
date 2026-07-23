defmodule NeutralCrossUnsafe.Target do
  def dispatch(key), do: apply(NeutralCrossUnsafe.RuntimeTarget, key, [])
  def consume_unknown(value), do: NeutralBoundary.Consumer.consume(value)
  def make(raw), do: String.to_atom(raw)
  def consume_defaulted(value \\ :fallback), do: Atom.to_string(value)
end
