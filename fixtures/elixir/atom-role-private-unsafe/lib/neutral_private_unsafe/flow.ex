defmodule NeutralPrivateUnsafe.Flow do
  def public_escape(raw), do: public_identity(build_key(raw))
  def invoke(raw), do: invoke_key(String.to_existing_atom(raw))
  def public_identity(value), do: value
  def risky_unused, do: :unused

  defp build_key(raw), do: String.to_existing_atom(raw)
  defp invoke_key(key), do: apply(NeutralPrivateUnsafe.Target, key, [])
end
