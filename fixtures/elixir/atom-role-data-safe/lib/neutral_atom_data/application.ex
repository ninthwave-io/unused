defmodule NeutralAtomData.Application do
  use Application

  def start(_type, _args) do
    _ = NeutralAtomData.Flow.stringify("known")
    {:ok, self()}
  end
end
