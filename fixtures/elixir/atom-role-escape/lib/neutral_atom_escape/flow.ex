defmodule NeutralAtomEscape.Flow do
  def escaped_value(map, raw) do
    Map.put(map, :selected, String.to_existing_atom(raw))
  rescue
    ArgumentError -> map
  end

  def genuinely_unused, do: :unused
end
