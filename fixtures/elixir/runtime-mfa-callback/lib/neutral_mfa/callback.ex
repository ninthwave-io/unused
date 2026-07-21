defmodule NeutralMfa.Callback do
  def callback_name(_request), do: :handled
  def genuinely_unused, do: :unused
end
