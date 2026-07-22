defmodule NeutralAtomEscape.Application do
  use Application

  def start(_type, _args) do
    _ = NeutralAtomEscape.Flow.escaped_value(%{}, "known")
    _ = NeutralAtomEscape.Flow.map_callback_input("known")
    _ = NeutralAtomEscape.Flow.keyword_callback_input("known")
    _ = NeutralAtomEscape.Flow.enum_callback_input("known")
    {:ok, self()}
  end
end
