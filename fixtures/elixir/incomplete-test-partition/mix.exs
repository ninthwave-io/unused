defmodule NeutralPartition.MixProject do
  use Mix.Project

  def project do
    [app: :neutral_partition, version: "0.1.0", elixir: "~> 1.17"]
  end

  def application do
    [mod: {NeutralPartition.Application, []}]
  end
end
