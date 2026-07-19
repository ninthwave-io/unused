defmodule Beh.MixProject do
  use Mix.Project

  def project, do: [app: :beh, version: "0.1.0", elixir: "~> 1.17"]
  def application, do: [mod: {Beh.Application, []}]
end
