defmodule HeexExp.TemplatePage do
  use Phoenix.Component

  embed_templates "template_page/*"

  def unrelated_dead(assigns) do
    ~H"""
    <span>not called</span>
    """
  end
end
