defmodule NeutralLocal.Dispatch do
  def dispatch(selected, value), do: apply(__MODULE__, selected, arguments(value))

  def live_action(value), do: {:live, value}
  def possible_action(value), do: {:possible, value}

  defp arguments(value), do: [value]
end
