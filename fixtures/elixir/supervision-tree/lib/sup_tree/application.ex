defmodule SupTree.Application do
  use Application

  @impl true
  def start(_type, _args) do
    # SupTree.Worker is passed as a child *atom* — never called by name here.
    children = [SupTree.Worker]
    Supervisor.start_link(children, strategy: :one_for_one)
  end
end
