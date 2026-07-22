defmodule NeutralGlobal.Application do
  use Application

  def start(_type, _args) do
    _ = NeutralGlobal.Dispatch.dispatch(NeutralGlobal.Target, :live_action, :value)
    _ = NeutralGlobal.Target.live_action(:value)
    {:ok, self()}
  end
end
