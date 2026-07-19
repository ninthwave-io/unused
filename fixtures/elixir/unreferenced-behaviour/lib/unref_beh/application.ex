defmodule UnrefBeh.Application do
  use Application

  @impl true
  def start(_type, _args) do
    # Only UnrefBeh.LiveServer is supervised; UnrefBeh.OrphanServer is referenced
    # by nothing. There is no apply/Module.concat anywhere in this unit.
    Supervisor.start_link([UnrefBeh.LiveServer], strategy: :one_for_one)
  end
end
