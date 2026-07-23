defmodule NeutralCrossFlow.Application do
  use Application

  def start(_type, _args) do
    _ = NeutralCrossFlow.Flow.direct?(%{known: true}, "known")
    _ = NeutralCrossFlow.Flow.pass?(%{known: true}, "known")
    _ = NeutralCrossFlow.Flow.imported?(%{known: true}, "known")
    _ = NeutralCrossFlow.Flow.wrapped?(%{known: true}, "known")
    {:ok, self()}
  end
end
