defmodule NeutralAtomRoles.Flows do
  def safe_key(map, raw) do
    Map.has_key?(map, String.to_existing_atom(raw))
  rescue
    ArgumentError -> false
  end

  def invoke(raw) do
    function = String.to_existing_atom(raw)
    apply(NeutralAtomRoles.Target, function, [])
  rescue
    ArgumentError -> :invalid
  end

  def reduce_explicit(entries, raw) do
    Enum.reduce(entries, %{}, fn key, acc ->
      pair = fn left, right -> {left, right} end
      _ = pair.(key, acc)
      Map.put(acc, key, String.to_existing_atom(raw))
    end)
    |> Map.has_key?(:known)
  rescue
    ArgumentError -> false
  end

  def reduce_piped(entries, raw) do
    entries
    |> Enum.reduce(%{}, fn
      {key, _value}, acc -> Map.put(acc, key, String.to_existing_atom(raw))
      _other, acc -> Map.put(acc, :fallback, :known)
    end)
    |> Map.has_key?(:known)
  rescue
    ArgumentError -> false
  end

  def genuinely_unused, do: :unused
end
