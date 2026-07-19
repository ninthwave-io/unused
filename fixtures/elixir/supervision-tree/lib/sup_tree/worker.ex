defmodule SupTree.Worker do
  @moduledoc "A supervised GenServer: alive via the supervision tree, callbacks dispatched by OTP."
  use GenServer

  def start_link(arg), do: GenServer.start_link(__MODULE__, arg, name: __MODULE__)

  @impl true
  def init(state), do: {:ok, state}

  @impl true
  def handle_call(:status, _from, state), do: {:reply, :ok, state}
end
