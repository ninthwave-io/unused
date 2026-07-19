defmodule Dyn.Application do
  use Application

  @impl true
  def start(_type, _args) do
    _ = Dyn.Handlers.ping()
    _ = Dyn.Router.dispatch(:ping)
    {:ok, self()}
  end
end
