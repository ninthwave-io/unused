defmodule PlainSup.Cache do
  @moduledoc """
  A PLAIN module (no `use GenServer`, no @behaviour) used as a supervised child.
  Its child_spec/1 and start_link/1 are invoked reflectively by the supervisor —
  never by name — so they must be kept alive without relying on a behaviour.
  """
  def child_spec(arg) do
    %{id: __MODULE__, start: {__MODULE__, :start_link, [arg]}}
  end

  def start_link(_arg), do: Agent.start_link(fn -> %{} end, name: __MODULE__)
end
