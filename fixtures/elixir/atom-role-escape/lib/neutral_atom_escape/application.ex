defmodule NeutralAtomEscape.Application do
  use Application

  def start(_type, _args) do
    _ = NeutralAtomEscape.Flow.escaped_value(%{}, "known")
    {:ok, self()}
  end
end
