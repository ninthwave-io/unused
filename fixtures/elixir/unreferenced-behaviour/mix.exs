defmodule UnrefBeh.MixProject do
  use Mix.Project

  def project, do: [app: :unref_beh, version: "0.1.0", elixir: "~> 1.17"]
  def application, do: [mod: {UnrefBeh.Application, []}]
end
