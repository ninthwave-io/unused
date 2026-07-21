defmodule NeutralPartition.Application do
  use Application

  @impl true
  def start(_type, _args) do
    Application.put_env(:neutral_partition, :runtime_marker, :started)
    Supervisor.start_link([], strategy: :one_for_one, name: NeutralPartition.Supervisor)
  end
end
