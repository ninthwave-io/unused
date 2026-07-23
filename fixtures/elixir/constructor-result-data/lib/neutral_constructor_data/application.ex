defmodule NeutralConstructorData.Application do
  use Application

  def start(_type, _args) do
    changeset = %{__struct__: Ecto.Changeset, errors: [], valid?: true}
    _ = NeutralConstructorData.Flow.money_currency("USD")
    _ = NeutralConstructorData.Flow.error_key(changeset, "field")
    {:ok, self()}
  end
end
