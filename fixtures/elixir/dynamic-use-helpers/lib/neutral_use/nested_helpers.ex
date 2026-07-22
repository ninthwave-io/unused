defmodule NeutralUse.NestedFirst do
  defmacro __using__(_options) do
    quote do
      def nested_first, do: :first
    end
  end
end

defmodule NeutralUse.NestedSecond do
  defmacro __using__(_options) do
    quote do
      def nested_second, do: :second
    end
  end
end
