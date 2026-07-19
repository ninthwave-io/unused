defmodule BasicDead.Application do
  @moduledoc "OTP application callback — the production entrypoint."
  use Application

  @impl true
  def start(_type, _args) do
    _ = BasicDead.Core.greet("world")
    Supervisor.start_link([], strategy: :one_for_one)
  end
end
