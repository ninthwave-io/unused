defmodule NeutralOnLoad.Application do
  use Application

  @impl true
  def start(_type, _args) do
    _ = NeutralOnLoad.NativeBoundary.reachable()
    _ = NeutralOnLoad.NativeBoundary.with_default()
    Supervisor.start_link([], strategy: :one_for_one)
  end
end
