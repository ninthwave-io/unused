defmodule NeutralGlobal.Dispatch do
  def dispatch(runtime_module, selected, value) do
    apply(runtime_module, selected, arguments(value))
  end

  defp arguments(value), do: [value]
end
