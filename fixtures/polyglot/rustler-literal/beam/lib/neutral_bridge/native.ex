defmodule NeutralBridge.Native do
  use Rustler,
    otp_app: :neutral_bridge,
    crate: :neutral_native

  def loader_marker, do: :ok
  def live_nif(left, right), do: :erlang.nif_error(:nif_not_loaded)
  def dead_nif(value), do: :erlang.nif_error(:nif_not_loaded)
end
