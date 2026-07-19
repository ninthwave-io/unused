defmodule Dyn.Handlers do
  # Reached by a static call from the app callback.
  def ping, do: :pong

  # Reached by nothing statically — but an `apply/3` in Dyn.Router could name it
  # at runtime, so it can only ever be a MEDIUM-confidence dead claim, never high.
  def dead_handler, do: :never
end
