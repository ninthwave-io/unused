defmodule PlainSup.Application do
  use Application

  @impl true
  def start(_type, _args) do
    Supervisor.start_link([PlainSup.Cache], strategy: :one_for_one)
  end
end
