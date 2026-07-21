defmodule NeutralUse.Application do
  use Application

  @impl true
  def start(_type, _args) do
    _ = NeutralUse.Router.kind()
    _ = NeutralUse.Controller.kind()
    _ = NeutralUse.Channel.kind()
    _ = NeutralUse.Html.kind()
    {:ok, self()}
  end
end
