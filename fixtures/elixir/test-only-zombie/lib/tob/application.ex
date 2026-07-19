defmodule Tob.Application do
  use Application

  @impl true
  def start(_type, _args) do
    _ = Tob.Calc.add(1, 2)
    {:ok, self()}
  end
end
