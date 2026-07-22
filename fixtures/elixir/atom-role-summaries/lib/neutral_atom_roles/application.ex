defmodule NeutralAtomRoles.Application do
  use Application

  def start(_type, _args) do
    _ = NeutralAtomRoles.Flows.safe_key(%{known: :value}, "known")
    _ = NeutralAtomRoles.Flows.invoke("action")
    _ = NeutralAtomRoles.Flows.map_explicit([:known], "known")
    _ = NeutralAtomRoles.Flows.map_piped([known: :value], "known")
    {:ok, self()}
  end
end
