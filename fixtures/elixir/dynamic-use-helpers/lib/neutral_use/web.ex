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
      use NeutralUse.NestedFirst
      use NeutralUse.NestedSecond
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

defmodule NeutralUse.Decoy do
  defmacro __using__(:controller) do
    quote do
      def kind, do: :decoy
    end
  end

  def controller, do: :not_selected_by_the_macro
end
