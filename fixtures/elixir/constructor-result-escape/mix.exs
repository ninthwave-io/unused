defmodule NeutralConstructorEscape.MixProject do
  use Mix.Project

  def project do
    [
      app: :neutral_constructor_escape,
      version: "0.1.0",
      elixir: "~> 1.17",
      deps: [
        {:ecto, "3.14.1", only: :test},
        {:money, "1.15.0", only: :test}
      ]
    ]
  end

  def application, do: [mod: {NeutralConstructorEscape.Application, []}]
end
