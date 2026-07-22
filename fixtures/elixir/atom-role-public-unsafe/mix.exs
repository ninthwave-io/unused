defmodule NeutralPublicUnsafe.MixProject do
  use Mix.Project

  def project, do: [app: :neutral_public_unsafe, version: "0.1.0", elixir: "~> 1.17"]
  def application, do: [mod: {NeutralPublicUnsafe.Application, []}]
end
