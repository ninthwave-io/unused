defmodule Dyn.Router do
  @moduledoc "Dispatches dynamically — the runtime target is not statically resolvable."

  def dispatch(name), do: apply(Dyn.Handlers, name, [])
  def exact, do: apply(Dyn.Handlers, :ping, [])
end
