defmodule NeutralConstructorEscape.Flow do
  def money_currency(raw) do
    Money.new(100, String.to_atom(raw))
    |> NeutralConstructorEscape.External.keep()
  end

  def error_key(changeset, raw) do
    Ecto.Changeset.add_error(changeset, String.to_atom(raw), "invalid")
    |> NeutralConstructorEscape.External.keep()
  end

  def genuinely_unused, do: :unused
end
