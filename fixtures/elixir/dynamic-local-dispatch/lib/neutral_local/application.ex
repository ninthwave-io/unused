defmodule NeutralLocal.Application do
  use Application

  def start(_type, _args) do
    _ = NeutralLocal.Dispatch.dispatch(:live_action, :value)
    _ = NeutralLocal.Dispatch.live_action(:value)
    {:ok, self()}
  end
end
