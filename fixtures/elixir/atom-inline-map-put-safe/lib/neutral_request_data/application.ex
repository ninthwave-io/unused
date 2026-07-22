defmodule NeutralRequestData.Application do
  use Application

  def start(_type, _args) do
    _ = NeutralRequestData.Normalizer.normalize(%{"kind" => "known"})
    {:ok, self()}
  end
end
