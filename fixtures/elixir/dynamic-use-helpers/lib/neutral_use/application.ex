defmodule NeutralUse.Application do
  use Application

  @impl true
  def start(_type, _args) do
    _ = NeutralUse.Router.kind()
    _ = NeutralUse.Controller.kind()
    _ = NeutralUse.Controller.nested_first()
    _ = NeutralUse.Controller.nested_second()
    _ = NeutralUse.Channel.kind()
    _ = NeutralUse.Html.kind()
    _ = NeutralUse.DecoyConsumer.kind()
    {:ok, self()}
  end
end
