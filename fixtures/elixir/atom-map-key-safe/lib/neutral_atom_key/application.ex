defmodule NeutralAtomKey.Application do
  use Application

  def start(_type, _args) do
    _ = NeutralAtomKey.Lookup.fetch(%{known: :value}, "known")
    _ = NeutralAtomKey.Lookup.masked(%{known: :value}, "known")
    _ = NeutralAtomKey.Lookup.predicate(%{known: :value}, "known")
    {:ok, self()}
  end
end
