defmodule NeutralPrivateFlow.Safe do
  def lookup?(map, raw), do: contains?(map, build_key(raw))

  def genuinely_unused, do: :unused

  defp build_key(raw), do: String.to_existing_atom(raw)
  defp contains?(map, key), do: Map.has_key?(map, key)
end
