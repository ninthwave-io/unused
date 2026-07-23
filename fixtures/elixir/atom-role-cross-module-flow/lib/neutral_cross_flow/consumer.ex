defmodule NeutralCrossFlow.Consumer do
  def consume?(map, key), do: Map.has_key?(map, key)
  def identity(value), do: value
end
