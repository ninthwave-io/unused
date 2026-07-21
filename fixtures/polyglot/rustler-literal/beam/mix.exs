defmodule NeutralBridge.MixProject do
  use Mix.Project

  def project do
    [app: :neutral_bridge, version: "0.1.0", elixir: "~> 1.15"]
  end

  def application do
    [extra_applications: [:logger], mod: {NeutralBridge.Application, []}]
  end
end
