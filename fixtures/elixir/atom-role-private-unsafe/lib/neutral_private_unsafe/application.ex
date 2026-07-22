defmodule NeutralPrivateUnsafe.Application do
  use Application

  def start(_type, _args) do
    _ = NeutralPrivateUnsafe.Flow.public_escape("known")
    _ = NeutralPrivateUnsafe.Flow.invoke("known")
    {:ok, self()}
  end
end
