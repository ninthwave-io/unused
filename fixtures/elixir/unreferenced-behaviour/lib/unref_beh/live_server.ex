defmodule UnrefBeh.LiveServer do
  @moduledoc "A supervised GenServer: reachable, so its callbacks are kept alive."
  use GenServer

  def start_link(arg), do: GenServer.start_link(__MODULE__, arg, name: __MODULE__)

  @impl true
  def init(state), do: {:ok, state}

  @impl true
  def handle_call(:ping, _from, state), do: {:reply, :pong, state}
end
