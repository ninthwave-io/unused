defmodule NeutralCrossUnsafe.Flow do
  def invocation(raw), do: NeutralCrossUnsafe.Target.dispatch(String.to_atom(raw))
  def unknown(raw), do: NeutralCrossUnsafe.Target.consume_unknown(String.to_atom(raw))
  def produced(raw), do: NeutralCrossUnsafe.Target.make(raw)
  def defaulted(raw), do: NeutralCrossUnsafe.Target.consume_defaulted(String.to_atom(raw))

  def genuinely_unused, do: :unused
end
