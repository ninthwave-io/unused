defmodule NeutralScript.Target do
  def zero, do: :zero
  def one(value), do: value
  def callback(fun), do: fun.(:left, :right)
  def multiline(value), do: value
end
