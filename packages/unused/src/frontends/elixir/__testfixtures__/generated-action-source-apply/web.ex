defmodule NeutralGenerated.Web do
  defmacro __using__(which) when is_atom(which) do
    apply(__MODULE__, which, [])
  end

  def controller do
    quote do
      use Phoenix.Controller
      def kind, do: :controller
    end
  end
end
