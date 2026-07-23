defmodule NeutralCrossUnsafe.Application do
  use Application

  def start(_type, _args) do
    _ = NeutralCrossUnsafe.Flow.invocation("run")
    _ = NeutralCrossUnsafe.Flow.unknown("known")
    _ = NeutralCrossUnsafe.Flow.produced("known")
    _ = NeutralCrossUnsafe.Flow.defaulted("known")
    {:ok, self()}
  end
end
