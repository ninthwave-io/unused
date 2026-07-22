defmodule NeutralPublicFlow.Application do
  use Application

  def start(_type, _args) do
    _ = NeutralPublicFlow.Safe.direct?(%{known: true}, "known")
    _ = NeutralPublicFlow.Safe.passed?(%{known: true}, "known")
    {:ok, self()}
  end
end
