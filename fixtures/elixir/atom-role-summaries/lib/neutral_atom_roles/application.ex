defmodule NeutralAtomRoles.Application do
  use Application

  def start(_type, _args) do
    _ = NeutralAtomRoles.Flows.safe_key(%{known: :value}, "known")
    _ = NeutralAtomRoles.Flows.invoke("action")
    {:ok, self()}
  end
end
