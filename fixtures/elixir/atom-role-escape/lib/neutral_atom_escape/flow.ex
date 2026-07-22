defmodule NeutralAtomEscape.Flow do
  def escaped_value(map, raw) do
    Map.put(map, :selected, String.to_existing_atom(raw))
  rescue
    ArgumentError -> map
  end

  def map_callback_input(raw) do
    Map.update(%{selected: String.to_existing_atom(raw)}, :selected, :known, fn selector ->
      {__MODULE__, selector, []}
    end)
    |> Map.has_key?(:selected)
  rescue
    ArgumentError -> %{}
  end

  def keyword_callback_input(raw) do
    [selected: String.to_existing_atom(raw)]
    |> Keyword.update(:selected, :known, fn selector -> {__MODULE__, selector, []} end)
    |> Keyword.has_key?(:selected)
  rescue
    ArgumentError -> []
  end

  def enum_callback_input(raw) do
    Enum.map([String.to_existing_atom(raw)], fn
      selector when is_atom(selector) -> {__MODULE__, selector, []}
      _other -> :known
    end)
  rescue
    ArgumentError -> []
  end

  def genuinely_unused, do: :unused
end
