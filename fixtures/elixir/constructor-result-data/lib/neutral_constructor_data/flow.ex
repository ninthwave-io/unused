defmodule NeutralConstructorData.Flow do
  def money_currency(raw) do
    Money.new(100, String.to_atom(raw))
    |> Map.fetch!(:currency)
    |> Atom.to_string()
  end

  def error_key(changeset, raw) do
    Ecto.Changeset.add_error(changeset, String.to_atom(raw), "invalid")
    |> Map.has_key?(:errors)
  end

  def genuinely_unused, do: :unused
end
