defmodule HeexExp.MixProject do
  use Mix.Project

  def project, do: [app: :heex_exp, version: "0.1.0", elixir: "~> 1.17", deps: deps()]
  def application, do: [mod: {HeexExp.Application, []}, extra_applications: [:logger]]
  defp deps, do: [{:phoenix_live_view, "~> 1.0"}]
end
