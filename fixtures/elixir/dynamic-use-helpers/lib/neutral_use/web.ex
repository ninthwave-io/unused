defmodule NeutralUse.Web do
  @moduledoc "A neutral form of the conventional web-module use dispatcher."

  defmacro __using__(which) when is_atom(which) do
    apply(__MODULE__, which, [])
  end

  def router do
    quote do
      def kind, do: :router
    end
  end

  def controller do
    quote do
      def kind, do: :controller
    end
  end

  def channel do
    quote do
      def kind, do: :channel
    end
  end

  def html do
    quote do
      def kind, do: :html
    end
  end

  def genuinely_unused, do: :unused
end
