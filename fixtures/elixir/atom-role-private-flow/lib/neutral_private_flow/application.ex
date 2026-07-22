defmodule NeutralPrivateFlow.Application do
  use Application

  def start(_type, _args) do
    _ = NeutralPrivateFlow.Safe.lookup?(%{known: true}, "known")
    {:ok, self()}
  end
end
