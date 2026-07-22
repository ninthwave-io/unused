defmodule NeutralAtomData.Flow do
  def stringify(raw) do
    raw
    |> String.to_existing_atom()
    |> Atom.to_string()
  rescue
    ArgumentError -> "invalid"
  end

  def genuinely_unused, do: :unused
end
