defmodule NeutralAtomData.Application do
  use Application

  def start(_type, _args) do
    _ = NeutralAtomData.Normalizer.normalize([%{value: 1}], "known")
    {:ok, self()}
  end
end
