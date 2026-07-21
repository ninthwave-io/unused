defmodule NeutralMfa.Application do
  use Application

  @impl true
  def start(_type, _args) do
    NeutralMfa.Runtime.invoke(NeutralMfa.RuntimeConfig.callback())
    {:ok, self()}
  end
end
