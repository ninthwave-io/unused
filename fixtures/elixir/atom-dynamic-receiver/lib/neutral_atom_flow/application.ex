defmodule NeutralAtomFlow.Application do
  use Application

  def start(_type, _args) do
    _ = NeutralAtomFlow.Dispatch.immediate("Elixir.NeutralAtomFlow.Target")
    _ = NeutralAtomFlow.Dispatch.assigned("Elixir.NeutralAtomFlow.Target")
    _ = NeutralAtomFlow.Dispatch.mixed(%{known: :value}, "known")
    {:ok, self()}
  end
end
