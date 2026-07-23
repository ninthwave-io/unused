defmodule NeutralDefaults.Application do
  use Application

  @impl true
  def start(_type, _args) do
    _ = NeutralDefaults.Actions.from_short(:entry)
    _ = NeutralDefaults.Actions.direct(:entry, :explicit)
    _ = NeutralDefaults.Actions.ranged(:entry)
    Supervisor.start_link([], strategy: :one_for_one)
  end
end
