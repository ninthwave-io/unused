defmodule Beh.Application do
  use Application

  @impl true
  def start(_type, _args) do
    _ = Beh.EmailHandler.describe()
    {:ok, self()}
  end
end
