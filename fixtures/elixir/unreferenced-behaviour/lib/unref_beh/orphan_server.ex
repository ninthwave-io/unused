defmodule UnrefBeh.OrphanServer do
  @moduledoc "A GenServer referenced by nothing: not supervised, not aliased, not config-named."
  use GenServer

  def start_link(arg), do: GenServer.start_link(__MODULE__, arg)

  @impl true
  def init(state), do: {:ok, state}
end
