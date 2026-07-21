defmodule NeutralBridge.Application do
  use Application

  @impl true
  def start(_type, _args) do
    NeutralBridge.Native.loader_marker()
    NeutralBridge.Native.live_nif(20, 22)
    Supervisor.start_link([], strategy: :one_for_one, name: NeutralBridge.Supervisor)
  end
end
