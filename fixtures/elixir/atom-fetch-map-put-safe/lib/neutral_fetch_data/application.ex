defmodule NeutralFetchData.Application do
  use Application

  def start(_type, _args) do
    _ = NeutralFetchData.Normalizer.normalize(%{"kind" => "known"})
    {:ok, self()}
  end
end
