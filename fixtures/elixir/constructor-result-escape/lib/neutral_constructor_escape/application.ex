defmodule NeutralConstructorEscape.Application do
  use Application

  def start(_type, _args) do
    changeset = %{__struct__: Ecto.Changeset, errors: [], valid?: true}
    _ = NeutralConstructorEscape.Flow.money_currency("USD")
    _ = NeutralConstructorEscape.Flow.error_key(changeset, "field")
    {:ok, self()}
  end
end
