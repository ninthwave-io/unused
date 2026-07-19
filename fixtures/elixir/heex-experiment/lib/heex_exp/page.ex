defmodule HeexExp.Page do
  use Phoenix.Component
  import HeexExp.Components

  def render(assigns) do
    ~H"""
    <div>
      <.greeting name="world" />
    </div>
    """
  end
end
