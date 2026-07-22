defmodule NeutralAtomFlow.Application do
  use Application

  def start(_type, _args) do
    _ = NeutralAtomFlow.Dispatch.immediate("Elixir.NeutralAtomFlow.Target")
    entries = [%{value: :known}]
    _ = NeutralAtomFlow.Dispatch.assigned(entries, "Elixir.NeutralAtomFlow.Target")
    _ = NeutralAtomFlow.Dispatch.assigned_apply(entries, "Elixir.NeutralAtomFlow.Target")
    _ = NeutralAtomFlow.Dispatch.assigned_capture(entries, "Elixir.NeutralAtomFlow.Target")
    _ = NeutralAtomFlow.Dispatch.assigned_mfa(entries, "Elixir.NeutralAtomFlow.Target")
    _ = NeutralAtomFlow.Dispatch.mixed(%{known: :value}, "known")
    _ = NeutralAtomFlow.Dispatch.inline_dynamic_key("known", %{}, :kind)
    _ = NeutralAtomFlow.Dispatch.tuple_only("known", :value)
    _ = NeutralAtomFlow.Dispatch.mfa_pipeline([{"known", :value}])
    _ = NeutralAtomFlow.Dispatch.intervening_pipeline([{"known", :value}])
    _ = NeutralAtomFlow.Dispatch.sequenced_pipeline([{"known", :value}])
    _ = NeutralAtomFlow.Dispatch.nested_pipeline([{"known", :value}])
    {:ok, self()}
  end
end
