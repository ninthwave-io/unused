defmodule HeexExp.Components do
  @moduledoc "Function components. `use Phoenix.Component` declares no behaviour, so components stay claimable."
  use Phoenix.Component

  attr :name, :string, required: true

  def greeting(assigns) do
    ~H"""
    <p>Hello, {@name}</p>
    """
  end

  # Rendered by nobody. HEEx component references ARE visible to the tracer, so
  # an unrendered component is a real dead-code claim (the finding this case records).
  def unused_component(assigns) do
    ~H"""
    <p>nobody renders me</p>
    """
  end
end
