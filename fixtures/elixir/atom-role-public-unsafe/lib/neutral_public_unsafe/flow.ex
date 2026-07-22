defmodule NeutralPublicUnsafe.Flow do
  def invoke(raw), do: dispatch(String.to_existing_atom(raw))
  def public_origin(raw), do: make(raw)
  def ambiguous(raw), do: overloaded(String.to_existing_atom(raw))
  def risky_unused, do: :unused

  def dispatch(key), do: apply(NeutralPublicUnsafe.Target, key, [])
  def make(raw), do: String.to_existing_atom(raw)
  def overloaded(value), do: Atom.to_string(value)
  def overloaded(value), do: value.run()
end
