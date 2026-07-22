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

  def map_explicit(entries, raw) do
    Map.new(entries, fn key ->
      pair = fn left, right -> {left, right} end
      _ = pair.(key, raw)
      {key, String.to_existing_atom(raw)}
    end)
    |> Map.has_key?(:known)
  rescue
    ArgumentError -> false
  end

  def map_piped(entries, raw) do
    entries
    |> Map.new(fn
      {key, _value} -> {key, String.to_existing_atom(raw)}
      _other -> {:fallback, :known}
    end)
    |> Map.has_key?(:known)
  rescue
    ArgumentError -> false
  end

  def genuinely_unused, do: :unused
end
