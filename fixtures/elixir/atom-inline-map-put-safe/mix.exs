defmodule NeutralRequestData.MixProject do
  use Mix.Project

  def project, do: [app: :neutral_request_data, version: "0.1.0", elixir: "~> 1.17"]
  def application, do: [mod: {NeutralRequestData.Application, []}]
end
