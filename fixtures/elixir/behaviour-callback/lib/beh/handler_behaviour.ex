defmodule Beh.HandlerBehaviour do
  @moduledoc "A custom behaviour whose callbacks are invoked by a dispatcher, never by name."
  @callback handle(event :: term()) :: :ok
end
