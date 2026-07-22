defmodule HeexExp.Application do
  use Application

  @impl true
  def start(_type, _args) do
    # Rendering the page exercises the components it references via HEEx.
    _ = HeexExp.Page.render(%{})
    _ = HeexExp.TemplatePage.index(%{})
    {:ok, self()}
  end
end
