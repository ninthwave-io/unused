defmodule NeutralPublicUnsafe.Application do
  use Application

  def start(_type, _args) do
    _ = NeutralPublicUnsafe.Flow.invoke("known")
    _ = NeutralPublicUnsafe.Flow.public_origin("known")
    _ = NeutralPublicUnsafe.Flow.ambiguous("known")
    {:ok, self()}
  end
end
