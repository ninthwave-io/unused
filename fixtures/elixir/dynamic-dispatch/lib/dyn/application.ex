defmodule Dyn.Application do
  use Application

  @impl true
  def start(_type, _args) do
    _ = Dyn.Router.dispatch(:ping)
    _ = Dyn.Router.exact()
    {:ok, self()}
  end
end
