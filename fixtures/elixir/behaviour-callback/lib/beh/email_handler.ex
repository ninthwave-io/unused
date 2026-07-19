defmodule Beh.EmailHandler do
  @moduledoc "Implements Beh.HandlerBehaviour."
  @behaviour Beh.HandlerBehaviour

  # A normal public function, called from the application callback.
  def describe, do: "email handler"

  # A behaviour callback — dispatched reflectively, never called by name. This is
  # the false-positive trap: it LOOKS dead, but deleting it breaks the behaviour.
  @impl true
  def handle(_event), do: :ok
end
