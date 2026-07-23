defmodule NeutralDefaults.Worker do
  def perform(value, mode), do: {value, mode}
  def unused_sibling(value), do: value
end
