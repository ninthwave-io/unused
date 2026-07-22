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

  def genuinely_unused, do: :unused
end
